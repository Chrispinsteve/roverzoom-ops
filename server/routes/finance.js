// Money: what came in, what is owed, and whether the books agree.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { auditor } = require('../lib/audit');
const { rideEconomics, summarizeEarnings, driverPayout, round2, DRIVER_BASE_SHARE } = require('../domain/money');

const router = express.Router();

function windowFrom(req) {
  const to = req.query.to || new Date().toISOString();
  const from = req.query.from || new Date(Date.now() - 30 * 86400_000).toISOString();
  return { from, to };
}

// GET /api/admin/finance/summary
router.get('/finance/summary', requireAdmin, requirePermission('finance.read'), async (req, res) => {
  try {
    const { from, to } = windowFrom(req);

    const { data: rides, error } = await supabase
      .from('bookings')
      .select('id, reference, fare, scheduled_at, completed_at, payment_method, payment_status, status')
      .eq('status', 'completed')
      .gte('completed_at', from)
      .lte('completed_at', to)
      .limit(5000);
    if (error) throw error;

    let gross = 0, standard = 0, discount = 0, driverShare = 0, platformShare = 0;
    let cardGross = 0, cashGross = 0, owedByDriversOnCash = 0;
    const byDay = new Map();

    for (const r of rides || []) {
      const e = rideEconomics(r);
      gross += e.fare;
      standard += e.standardFare;
      discount += e.discount;
      driverShare += e.driverShare;
      platformShare += e.platformShare;
      if (e.paymentMethod === 'cash') { cashGross += e.fare; owedByDriversOnCash += e.platformOwedByDriver; }
      else cardGross += e.fare;

      const day = (r.completed_at || r.scheduled_at || '').slice(0, 10);
      const bucket = byDay.get(day) || { day, rides: 0, gross: 0, platformShare: 0 };
      bucket.rides += 1; bucket.gross = round2(bucket.gross + e.fare);
      bucket.platformShare = round2(bucket.platformShare + e.platformShare);
      byDay.set(day, bucket);
    }

    // Fares marked paid vs not. A completed card ride whose payment never
    // settled is real lost revenue and must not hide inside the gross figure.
    const unpaid = (rides || []).filter((r) => r.payment_method === 'card' && r.payment_status !== 'paid');

    res.json({
      window: { from, to },
      model: { driverBaseShare: DRIVER_BASE_SHARE },
      totals: {
        rides: (rides || []).length,
        gross: round2(gross),
        standardValue: round2(standard),
        discountAbsorbed: round2(discount),
        driverShare: round2(driverShare),
        platformShare: round2(platformShare),
        cardGross: round2(cardGross),
        cashGross: round2(cashGross),
        // Cash rides mean the driver holds the platform's commission until it
        // is netted out of their next card cash-out.
        commissionHeldByDrivers: round2(owedByDriversOnCash),
      },
      unsettledCardRides: {
        count: unpaid.length,
        value: round2(unpaid.reduce((sum, r) => sum + Number(r.fare || 0), 0)),
        rides: unpaid.slice(0, 50).map((r) => ({
          id: r.id, reference: r.reference, fare: r.fare,
          payment_status: r.payment_status, completed_at: r.completed_at,
        })),
      },
      daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    });
  } catch (err) {
    console.error('[finance:summary]', err.message);
    res.status(500).json({ error: 'Could not load the finance summary.' });
  }
});

// GET /api/admin/finance/balances — what each driver is owed or owes.
router.get('/finance/balances', requireAdmin, requirePermission('finance.read'), async (req, res) => {
  try {
    const [{ data: earnings, error: eErr }, { data: drivers, error: dErr }] = await Promise.all([
      supabase.from('driver_earnings').select('*').limit(20000),
      supabase.from('drivers').select('id, name, phone, status, rides_completed').limit(2000),
    ]);
    if (eErr) throw eErr;
    if (dErr) throw dErr;

    const byDriver = new Map();
    for (const row of earnings || []) {
      if (!byDriver.has(row.driver_id)) byDriver.set(row.driver_id, []);
      byDriver.get(row.driver_id).push(row);
    }

    const balances = (drivers || []).map((d) => {
      const rows = byDriver.get(d.id) || [];
      const summary = summarizeEarnings(rows);
      return {
        driver_id: d.id, name: d.name, phone: d.phone,
        status: d.status, rides_completed: d.rides_completed,
        ...summary,
        // A negative payable means the driver has run enough cash rides that
        // they owe the platform more commission than their unpaid card
        // earnings cover. Surfaced explicitly rather than clamped to zero.
        owesPlatform: summary.payable < 0,
        ledgerRows: rows.length,
      };
    }).filter((b) => b.ledgerRows > 0);

    balances.sort((a, b) => b.payable - a.payable);

    res.json({
      balances,
      totals: {
        payable: round2(balances.reduce((s, b) => s + Math.max(b.payable, 0), 0)),
        owedToPlatform: round2(balances.reduce((s, b) => s + Math.min(b.payable, 0), 0)),
        paidOut: round2(balances.reduce((s, b) => s + b.paidOut, 0)),
      },
    });
  } catch (err) {
    console.error('[finance:balances]', err.message);
    res.status(500).json({ error: 'Could not load driver balances.' });
  }
});

// GET /api/admin/finance/reconciliation
//
// Catches the two silent failure modes in the live payout path:
//  1. complete_booking() writes the earnings row in the same transaction as
//     the status flip, so a completed ride with NO ledger row means that
//     transaction did not do what the schema promises — a real integrity bug.
//  2. The card transfer to Stripe Connect runs AFTER completion and its
//     failures are deliberately swallowed ("an untransferred share simply
//     stays owed in the ledger"). Nothing in the driver app surfaces that, so
//     money can sit unpaid indefinitely with no alarm anywhere.
router.get('/finance/reconciliation', requireAdmin, requirePermission('finance.read'), async (req, res) => {
  try {
    const { from, to } = windowFrom(req);

    const [{ data: rides, error: rErr }, { data: earnings, error: eErr }] = await Promise.all([
      supabase.from('bookings')
        .select('id, reference, fare, scheduled_at, completed_at, payment_method, driver_id')
        .eq('status', 'completed').gte('completed_at', from).lte('completed_at', to).limit(5000),
      supabase.from('driver_earnings').select('*').gte('created_at', from).limit(20000),
    ]);
    if (rErr) throw rErr;
    if (eErr) throw eErr;

    const fareRowsByBooking = new Map();
    for (const row of earnings || []) {
      if (row.type !== 'fare' || !row.booking_id) continue;
      fareRowsByBooking.set(row.booking_id, row);
    }

    const missingLedger = [];
    const amountMismatch = [];
    const untransferred = [];

    for (const ride of rides || []) {
      const row = fareRowsByBooking.get(ride.id);
      if (!row) {
        missingLedger.push({
          id: ride.id, reference: ride.reference, fare: ride.fare,
          completed_at: ride.completed_at, driver_id: ride.driver_id,
        });
        continue;
      }

      // Recompute what the driver SHOULD have been paid and compare. A cent of
      // rounding is fine; anything more means the model drifted.
      const expected = driverPayout(Number(ride.fare), ride.scheduled_at);
      const actual = Number(row.amount);
      if (Math.abs(expected - actual) > 0.01) {
        amountMismatch.push({
          id: ride.id, reference: ride.reference,
          expected, actual, delta: round2(actual - expected),
        });
      }

      if (ride.payment_method === 'card' && !row.paid_out_at) {
        untransferred.push({
          id: ride.id, reference: ride.reference, amount: actual,
          completed_at: ride.completed_at, driver_id: ride.driver_id,
          ageDays: Math.floor((Date.now() - new Date(ride.completed_at).getTime()) / 86400_000),
        });
      }
    }

    untransferred.sort((a, b) => b.ageDays - a.ageDays);

    res.json({
      window: { from, to },
      checked: (rides || []).length,
      healthy: missingLedger.length === 0 && amountMismatch.length === 0,
      findings: {
        missingLedger: {
          severity: 'critical',
          title: 'Completed rides with no earnings row',
          explanation: 'complete_booking() should write these atomically. A gap here is a data-integrity failure, and the driver was never credited.',
          count: missingLedger.length, items: missingLedger.slice(0, 100),
        },
        amountMismatch: {
          severity: 'critical',
          title: 'Ledger amount disagrees with the payout model',
          explanation: 'The recorded earning does not match a recomputation from the fare. Either the payout rate changed after the fact, or the console and the driver backend disagree.',
          count: amountMismatch.length, items: amountMismatch.slice(0, 100),
        },
        untransferred: {
          severity: 'warn',
          title: 'Card earnings never transferred',
          explanation: 'The Stripe Connect transfer runs after completion and its failures are swallowed by design. These are owed and unpaid.',
          count: untransferred.length,
          value: round2(untransferred.reduce((s, u) => s + u.amount, 0)),
          items: untransferred.slice(0, 100),
        },
      },
    });
  } catch (err) {
    console.error('[finance:reconciliation]', err.message);
    res.status(500).json({ error: 'Could not run reconciliation.' });
  }
});

// GET /api/admin/finance/payouts
router.get('/finance/payouts', requireAdmin, requirePermission('finance.read'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('driver_payouts').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) throw error;

    const ids = [...new Set((data || []).map((p) => p.driver_id))];
    const names = new Map();
    if (ids.length) {
      const { data: ds } = await supabase.from('drivers').select('id, name').in('id', ids);
      for (const d of ds || []) names.set(d.id, d.name);
    }

    res.json({
      payouts: (data || []).map((p) => ({ ...p, driver_name: names.get(p.driver_id) || null })),
    });
  } catch (err) {
    console.error('[finance:payouts]', err.message);
    res.status(500).json({ error: 'Could not load payouts.' });
  }
});

// POST /api/admin/finance/payouts/:id/paid  { externalPayoutId }
router.post('/finance/payouts/:id/paid', requireAdmin, requirePermission('finance.payout'), async (req, res) => {
  const audit = auditor(req);
  const { externalPayoutId } = req.body || {};

  try {
    const { data: payout } = await supabase
      .from('driver_payouts').select('*').eq('id', req.params.id).maybeSingle();
    if (!payout) return res.status(404).json({ error: 'Payout not found.' });
    if (payout.status === 'paid') {
      return res.status(409).json({ error: 'This payout is already marked paid.', code: 'already_paid' });
    }

    // Guarded on the pending status so two operators clicking at once cannot
    // both record a payment for the same money.
    const { data: updated, error } = await supabase
      .from('driver_payouts')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        external_payout_id: externalPayoutId ? String(externalPayoutId).trim() : payout.external_payout_id,
      })
      .eq('id', payout.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!updated) return res.status(409).json({ error: 'This payout was already settled.', code: 'race_lost' });

    await audit({
      action: 'finance.payout_paid', subjectType: 'payout', subjectId: payout.id,
      summary: `Marked payout of ${payout.amount} paid`,
      detail: { driver_id: payout.driver_id, amount: payout.amount, externalPayoutId: updated.external_payout_id },
    });

    res.json({ payout: updated });
  } catch (err) {
    console.error('[finance:payout-paid]', err.message);
    res.status(500).json({ error: 'Could not update the payout.' });
  }
});

module.exports = router;
