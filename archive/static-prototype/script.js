const overviewStats = [
  {
    label: 'Active rides',
    value: '376',
    trend: '+12.4%',
    note: 'Across 18 operating zones',
    tone: 'accent',
  },
  {
    label: 'Fleet health',
    value: '96%',
    trend: '+2.1%',
    note: 'Maintenance schedule on track',
    tone: '',
  },
  {
    label: 'Revenue today',
    value: '$64.8k',
    trend: '+$8.2k',
    note: 'Booked value in the last 24h',
    tone: '',
  },
  {
    label: 'Open alerts',
    value: '17',
    trend: '-4',
    note: 'Priority exceptions requiring review',
    tone: 'warning',
  },
];

const activityFeed = [
  { type: 'driver', title: 'Driver reassigned', detail: 'RZ-418 moved from Mission to Downtown', time: '2m ago' },
  { type: 'payment', title: 'Payout queued', detail: '14 drivers scheduled for settlement', time: '8m ago' },
  { type: 'safety', title: 'Safety review', detail: 'Passenger report escalated to ops lead', time: '16m ago' },
  { type: 'ride', title: 'Surge window active', detail: 'Airport demand is 27% above baseline', time: '22m ago' },
];

const rides = [
  {
    ride: 'RZ-2041',
    rider: 'Harbor Ventures',
    driver: 'M. Alvarez',
    route: 'San Jose → Palo Alto',
    status: 'In transit',
    value: '$420',
    stateClass: 'in-transit',
  },
  {
    ride: 'RZ-1988',
    rider: 'Northstar Labs',
    driver: 'A. Kim',
    route: 'Oakland → SF Airport',
    status: 'Ready',
    value: '$610',
    stateClass: 'ready',
  },
  {
    ride: 'RZ-1923',
    rider: 'Summit Realty',
    driver: 'D. Nguyen',
    route: 'Monterey → Santa Cruz',
    status: 'Delayed',
    value: '$540',
    stateClass: 'delayed',
  },
  {
    ride: 'RZ-1856',
    rider: 'Point Blue',
    driver: 'L. Brooks',
    route: 'Fremont → San Ramon',
    status: 'Ready',
    value: '$365',
    stateClass: 'ready',
  },
  {
    ride: 'RZ-1812',
    rider: 'Citywide Med',
    driver: 'J. Patel',
    route: 'Hayward → Berkeley',
    status: 'Boarding',
    value: '$290',
    stateClass: 'boarding',
  },
];

const fleetHealth = [
  { label: 'EV fleet', value: 94, detail: '14 units charging' },
  { label: 'SUV fleet', value: 89, detail: '9 services due' },
  { label: 'Luxury', value: 91, detail: '3 cleaning cycles' },
  { label: 'Vans', value: 82, detail: '6 inspections pending' },
];

const driverCompliance = [
  { name: 'Anya Ramos', item: 'Documents', status: 'Expiring in 5d', level: 'warn' },
  { name: 'Khalid Hassan', item: 'Insurance', status: 'Approved', level: 'ok' },
  { name: 'Nina Patel', item: 'Background', status: 'Review needed', level: 'alert' },
  { name: 'Louis Chen', item: 'Vehicle permit', status: 'Renewed', level: 'ok' },
];

const incidents = [
  { title: 'Passenger complaint', detail: 'Route mismatch in Oakland', severity: 'medium' },
  { title: 'Vehicle battery warning', detail: 'RZ-407 roadside service requested', severity: 'high' },
  { title: 'Payment anomaly', detail: 'Duplicate charge flagged for review', severity: 'low' },
];

const payouts = [
  { name: 'Driver settlement', amount: '$32,600', status: 'Queued' },
  { name: 'Partner payouts', amount: '$18,200', status: 'Processing' },
  { name: 'Refund reserve', amount: '$5,840', status: 'Review' },
];

const overviewStatsEl = document.getElementById('overview-stats');
const activityFeedEl = document.getElementById('activity-feed');
const ridesTableBody = document.getElementById('rides-table-body');
const fleetHealthList = document.getElementById('fleet-health-list');
const driverComplianceList = document.getElementById('driver-compliance');
const incidentFeed = document.getElementById('incident-feed');
const payoutList = document.getElementById('payout-list');

function renderOverviewStats() {
  overviewStatsEl.innerHTML = overviewStats
    .map(
      (stat) => `
        <article class="stat-card ${stat.tone}">
          <div class="card-meta">
            <span>${stat.label}</span>
            <span class="trend ${stat.tone === 'warning' ? 'down' : 'up'}">${stat.trend}</span>
          </div>
          <div class="stat-value">${stat.value}</div>
          <p>${stat.note}</p>
        </article>
      `
    )
    .join('');
}

function renderActivityFeed() {
  activityFeedEl.innerHTML = activityFeed
    .map(
      (item) => `
        <div class="activity-item">
          <span class="activity-icon ${item.type}"></span>
          <div>
            <strong>${item.title}</strong>
            <small>${item.detail}</small>
          </div>
          <time>${item.time}</time>
        </div>
      `
    )
    .join('');
}

function renderRides() {
  ridesTableBody.innerHTML = rides
    .map(
      (item) => `
        <tr>
          <td><strong>${item.ride}</strong></td>
          <td>${item.rider}</td>
          <td>${item.driver}</td>
          <td>${item.route}</td>
          <td><span class="badge ${item.stateClass}">${item.status}</span></td>
          <td>${item.value}</td>
        </tr>
      `
    )
    .join('');
}

function renderFleetHealth() {
  fleetHealthList.innerHTML = fleetHealth
    .map(
      (item) => `
        <div class="metric-row">
          <div class="metric-copy">
            <strong>${item.label}</strong>
            <small>${item.detail}</small>
          </div>
          <div class="meter">
            <span style="width: ${item.value}%"></span>
          </div>
          <em>${item.value}%</em>
        </div>
      `
    )
    .join('');
}

function renderDriverCompliance() {
  driverComplianceList.innerHTML = driverCompliance
    .map(
      (item) => `
        <div class="mini-item">
          <div>
            <strong>${item.name}</strong>
            <small>${item.item}</small>
          </div>
          <span class="tag ${item.level}">${item.status}</span>
        </div>
      `
    )
    .join('');
}

function renderIncidents() {
  incidentFeed.innerHTML = incidents
    .map(
      (item) => `
        <div class="mini-item">
          <div>
            <strong>${item.title}</strong>
            <small>${item.detail}</small>
          </div>
          <span class="tag ${item.severity}">${item.severity}</span>
        </div>
      `
    )
    .join('');
}

function renderPayouts() {
  payoutList.innerHTML = payouts
    .map(
      (item) => `
        <div class="payout-row">
          <div>
            <strong>${item.name}</strong>
            <small>${item.status}</small>
          </div>
          <span>${item.amount}</span>
        </div>
      `
    )
    .join('');
}

renderOverviewStats();
renderActivityFeed();
renderRides();
renderFleetHealth();
renderDriverCompliance();
renderIncidents();
renderPayouts();
