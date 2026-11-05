// Reads what `vercel deploy --non-interactive` prints (one JSON object) and prints the preview URL.
// Exits 1 on a failed deploy, naming Vercel's reason, and 3 when the deployment went to production,
// which this run must never do: a new project's first deploy is production even without --prod.
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (text += chunk));
process.stdin.on("end", () => {
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    console.error(
      "vercel deploy printed something other than its JSON result.",
    );
    process.exit(1);
  }
  if (result?.status !== "ok") {
    console.error(
      `vercel deploy failed: ${result?.reason ?? "unknown"}: ${result?.message ?? ""}`,
    );
    process.exit(1);
  }
  const deployment = result.deployment ?? {};
  if (deployment.target === "production") {
    console.error(
      `This deployment went to PRODUCTION, which the daily run must never do: ${deployment.url}. ` +
        "Check the project's protection and roll back with vercel rollback if needed.",
    );
    process.exit(3);
  }
  if (typeof deployment.url !== "string" || deployment.url === "") {
    console.error("vercel deploy reported no deployment URL.");
    process.exit(1);
  }
  console.log(deployment.url);
});
