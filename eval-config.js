/**
 * Cloud submit endpoint.
 *
 * Critical: the Web App must be public, otherwise browsers get 403 Access Denied.
 *
 * Deploy steps (from the Sheet-bound Apps Script project):
 * 1. Paste collect.gs into Extensions > Apps Script
 * 2. Deploy > New deployment > Web app
 * 3. Execute as: Me
 * 4. Who has access: Anyone   <-- must NOT be "Anyone with Google account"
 * 5. Deploy, then copy the /exec URL here
 * 6. After editing collect.gs later: Deploy > Manage deployments > Edit > New version
 *
 * Test: open the /exec URL in an Incognito window (logged out).
 * If you see Access Denied, redeploy with Anyone.
 */
window.EVAL_CONFIG = {
  submitUrl: "https://script.google.com/macros/s/AKfycbwtIYFc8U80DZDR_8VvUWIaexLCpiiqbrAgWMLEbbwGeAZ515jhjnLVeI47aSDk3eoLew/exec"
};