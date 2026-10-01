// Hook point where later modules (mixer, piano roll, playlist, browser, exporters …) attach
// themselves to the app object. Kept separate so app.js stays a thin wiring file.
export function installExtensions(app) {
  void app;
}
