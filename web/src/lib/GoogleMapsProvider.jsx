import { useJsApiLoader } from '@react-google-maps/api';
import { createContext, useContext } from 'react';

// Loads the Google Maps JS API exactly once, mirroring the pattern the rider
// and driver apps use (frontend/src/lib/GoogleMapsProvider.jsx).
//
// Declared at MODULE scope, never inline. useJsApiLoader compares this array
// by reference on every render; an inline literal creates a new array each
// time, which makes the loader believe the configuration changed and warn
// about — or attempt — a reload of an API that can only load once per page.
//
// The console needs no libraries at all: it plots points it already has and
// draws no routes, so it does not need `geometry`. The rider app loads that
// only to decode stored polylines. Fewer libraries is a smaller download
// before the map can paint.
const LIBRARIES = [];

const GoogleMapsContext = createContext({ isLoaded: false, loadError: undefined, hasApiKey: false });

export function GoogleMapsProvider({ children }) {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const hasApiKey = apiKey.length > 10;

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'roverzoom-ops-google-maps',
    googleMapsApiKey: apiKey,
    libraries: LIBRARIES,
    preventGoogleFontsLoading: !hasApiKey,
  });

  return (
    <GoogleMapsContext.Provider value={{ isLoaded: hasApiKey && isLoaded, loadError, hasApiKey }}>
      {children}
    </GoogleMapsContext.Provider>
  );
}

export function useGoogleMaps() {
  return useContext(GoogleMapsContext);
}
