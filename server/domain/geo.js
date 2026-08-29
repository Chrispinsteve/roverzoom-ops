// Straight-line distance. Mirrors haversineMiles() in
// roverzoom/backend/services/fare.js.
//
// Deliberately NOT road distance: this is used to RANK dispatch candidates,
// where the relative order of drivers a few miles apart is what matters, and
// a routing API call per candidate would cost real money and seconds on every
// board refresh. The console labels these as straight-line so an operator is
// never misled into reading them as an ETA.
const EARTH_MILES = 3958.8;
const toRad = (d) => (d * Math.PI) / 180;

function haversineMiles(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// The road-factor and average-speed assumptions the fare model already uses,
// reused here to turn a straight-line gap into a rough "minutes away".
const ROAD_FACTOR = 1.3;
const AVG_SPEED_MPH = 28;

function roughMinutesAway(miles) {
  return Math.max(1, Math.round((miles * ROAD_FACTOR) / AVG_SPEED_MPH * 60));
}

module.exports = { haversineMiles, roughMinutesAway, ROAD_FACTOR, AVG_SPEED_MPH };
