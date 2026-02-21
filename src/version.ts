declare const __FLUXHIVE_VERSION__: string;
export const VERSION: string =
  typeof __FLUXHIVE_VERSION__ !== "undefined"
    ? __FLUXHIVE_VERSION__
    : "0.0.0-dev";
