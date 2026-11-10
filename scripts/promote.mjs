// Promotes a verified preview to production through the Vercel API and prints the production URL.
// `vercel promote` looks up the token's user first, and the run's token belongs to the team, so the
// CLI fails with "User not found". This makes the call the CLI makes for a preview: a new production
// deployment from the preview's files. It reads VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID
// from the environment only and never prints them. Any refusal exits 1 and names the reason.
//
//   node scripts/promote.mjs <preview-url>
const API = process.env.VERCEL_API_URL || "https://api.vercel.com";
const WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 5000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [url] = process.argv.slice(2);
const { VERCEL_TOKEN: token, VERCEL_ORG_ID: team, VERCEL_PROJECT_ID: project } = process.env;
if (!url) fail("usage: node scripts/promote.mjs <preview-url>");
if (!token || !team || !project) {
  fail("VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID must all be set.");
}

async function api(path, init = {}) {
  const separator = path.includes("?") ? "&" : "?";
  let response;
  try {
    response = await fetch(`${API}${path}${separator}teamId=${encodeURIComponent(team)}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch (error) {
    fail(`The Vercel API could not be reached: ${error.message}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const method = init.method ?? "GET";
    fail(`The Vercel API refused ${method} ${path.split("?")[0]}: ${response.status} ${body.error?.message ?? ""}`.trim());
  }
  return body;
}

const host = new URL(url.includes("://") ? url : `https://${url}`).host;
const preview = await api(`/v13/deployments/${host}`);
if (preview.projectId !== project) fail(`${host} is not a deployment of this project.`);
if (preview.target === "production") fail(`${host} is already a production deployment.`);
if (preview.readyState !== "READY") fail(`${host} is ${preview.readyState}, not READY.`);

const made = await api("/v13/deployments?forceNew=1", {
  method: "POST",
  body: JSON.stringify({ name: preview.name, deploymentId: preview.id, project, target: "production" }),
});
if (typeof made.id !== "string") fail("Vercel made no production deployment.");

const deadline = Date.now() + WAIT_MS;
for (;;) {
  const deployment = await api(`/v13/deployments/${made.id}`);
  if (deployment.readyState === "READY") {
    if (deployment.target !== "production") fail(`The new deployment's target is ${deployment.target}, not production.`);
    console.log(`https://${deployment.url}`);
    process.exit(0);
  }
  if (["ERROR", "CANCELED"].includes(deployment.readyState)) {
    fail(`The production deployment ended ${deployment.readyState}.`);
  }
  if (Date.now() > deadline) fail("The production deployment was not READY within 5 minutes.");
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
