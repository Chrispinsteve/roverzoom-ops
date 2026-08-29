// Rider PII redaction.
//
// Rider contact details leave this API only for admins holding 'riders.pii'.
// Redaction happens at the SERIALIZATION boundary — not in the frontend —
// so a role without the permission never receives the data at all, and no
// amount of poking at the browser reveals it.
//
// Redacted values keep a recognizable shape (last 4 of a phone, first letter
// of a name) so an operator without PII access can still confirm they are
// looking at the right ride when someone reads a number to them, without
// being handed a directory of every rider RoverZoom has.

function maskPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return '•••';
  return `•••-•••-${digits.slice(-4)}`;
}

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = String(email).split('@');
  if (!domain) return '•••';
  return `${local.slice(0, 1)}•••@${domain}`;
}

function maskName(name) {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  const first = parts[0] || '';
  const lastInitial = parts.length > 1 ? ` ${parts[parts.length - 1][0]}.` : '';
  return `${first}${lastInitial}`;
}

// Applies to any object carrying rider_* columns from `bookings`.
function riderContact(booking, canSeePii) {
  if (canSeePii) {
    return {
      rider_name: booking.rider_name,
      rider_phone: booking.rider_phone,
      rider_email: booking.rider_email,
      pii_redacted: false,
    };
  }
  return {
    // A first name + last initial is enough to greet someone on a call and
    // not enough to build a contact list from.
    rider_name: maskName(booking.rider_name),
    rider_phone: maskPhone(booking.rider_phone),
    rider_email: maskEmail(booking.rider_email),
    pii_redacted: true,
  };
}

module.exports = { maskPhone, maskEmail, maskName, riderContact };
