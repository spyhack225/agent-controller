#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

export const FRONTEND_PERFORMANCE_BUDGETS = Object.freeze({
  initialJavaScriptRawBytes: 560 * 1024,
  initialJavaScriptGzipBytes: 160 * 1024,
  initialJavaScriptRequests: 4,
  initialCssGzipBytes: 40 * 1024,
  largestFeatureChunkGzipBytes: 28 * 1024,
  largestFeatureRouteGzipBytes: 36 * 1024,
  largestFeatureRouteRequests: 20,
});

export const REQUIRED_LAZY_FEATURES = Object.freeze([
  "ActivityPage",
  "ActionsPage",
  "ClaimPage",
  "DeveloperLandingPage",
  "DevicesPage",
  "EnvironmentsPage",
  "HardwareLandingPage",
  "LandingPage",
  "MediaPage",
  "OnboardingPage",
  "OperatePage",
  "QuickPage",
  "SettingsPage",
  "WorkspaceRecoveryDialog",
]);

function assetSize(distDirectory, file) {
  const path = resolve(distDirectory, file);
  const raw = statSync(path).size;
  const gzip = gzipSync(readFileSync(path), { level: 9 }).length;
  return { file, raw, gzip };
}

function collectStaticImports(manifest, key, collected = new Set()) {
  if (collected.has(key)) return collected;
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Manifest import ${key} does not exist.`);
  collected.add(key);
  for (const imported of chunk.imports ?? []) collectStaticImports(manifest, imported, collected);
  return collected;
}

export function analyzeFrontendBuild({ distDirectory, manifest }) {
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry === true);
  if (entries.length !== 1) throw new Error(`Expected exactly one browser entry, found ${entries.length}.`);
  const [entryKey, entry] = entries[0];
  const initialKeySet = collectStaticImports(manifest, entryKey);
  const initialKeys = [...initialKeySet];
  const initialJavaScript = initialKeys.map((key) => assetSize(distDirectory, manifest[key].file));
  const initialCss = (entry.css ?? []).map((file) => assetSize(distDirectory, file));
  const dynamicFeatures = Object.entries(manifest)
    .filter(([key, chunk]) => key.startsWith("src/features/") && chunk.isDynamicEntry === true)
    .map(([key, chunk]) => {
      const own = assetSize(distDirectory, chunk.file);
      const routeAssets = [...collectStaticImports(manifest, key)]
        .filter((routeKey) => !initialKeySet.has(routeKey))
        .map((routeKey) => assetSize(distDirectory, manifest[routeKey].file));
      return {
        key,
        name: chunk.name,
        ...own,
        routeRequests: routeAssets.length,
        routeRaw: routeAssets.reduce((sum, asset) => sum + asset.raw, 0),
        routeGzip: routeAssets.reduce((sum, asset) => sum + asset.gzip, 0),
      };
    })
    .sort((left, right) => right.routeGzip - left.routeGzip);
  return {
    initialJavaScript,
    initialJavaScriptRawBytes: initialJavaScript.reduce((sum, asset) => sum + asset.raw, 0),
    initialJavaScriptGzipBytes: initialJavaScript.reduce((sum, asset) => sum + asset.gzip, 0),
    initialCss,
    initialCssGzipBytes: initialCss.reduce((sum, asset) => sum + asset.gzip, 0),
    dynamicFeatures,
  };
}

export function assertFrontendPerformance(report, budgets = FRONTEND_PERFORMANCE_BUDGETS) {
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };
  check(
    report.initialJavaScriptRawBytes <= budgets.initialJavaScriptRawBytes,
    `initial JavaScript raw ${report.initialJavaScriptRawBytes} > ${budgets.initialJavaScriptRawBytes}`,
  );
  check(
    report.initialJavaScriptGzipBytes <= budgets.initialJavaScriptGzipBytes,
    `initial JavaScript gzip ${report.initialJavaScriptGzipBytes} > ${budgets.initialJavaScriptGzipBytes}`,
  );
  check(
    report.initialJavaScript.length <= budgets.initialJavaScriptRequests,
    `initial JavaScript requests ${report.initialJavaScript.length} > ${budgets.initialJavaScriptRequests}`,
  );
  check(
    report.initialCssGzipBytes <= budgets.initialCssGzipBytes,
    `initial CSS gzip ${report.initialCssGzipBytes} > ${budgets.initialCssGzipBytes}`,
  );
  const lazyNames = new Set(report.dynamicFeatures.map((feature) => feature.name));
  for (const required of REQUIRED_LAZY_FEATURES) {
    check(lazyNames.has(required), `${required} is no longer a lazy feature chunk`);
  }
  for (const feature of report.dynamicFeatures) {
    check(
      feature.gzip <= budgets.largestFeatureChunkGzipBytes,
      `${feature.name} feature gzip ${feature.gzip} > ${budgets.largestFeatureChunkGzipBytes}`,
    );
    check(
      feature.routeGzip <= budgets.largestFeatureRouteGzipBytes,
      `${feature.name} route gzip ${feature.routeGzip} > ${budgets.largestFeatureRouteGzipBytes}`,
    );
    check(
      feature.routeRequests <= budgets.largestFeatureRouteRequests,
      `${feature.name} route requests ${feature.routeRequests} > ${budgets.largestFeatureRouteRequests}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`Frontend performance budget failed:\n- ${failures.join("\n- ")}`);
  }
}

export function runFrontendPerformanceGate(distDirectory = resolve(projectRoot, "dist/web")) {
  const manifestPath = resolve(distDirectory, ".vite/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const report = analyzeFrontendBuild({ distDirectory, manifest });
  assertFrontendPerformance(report);
  return report;
}

function kibibytes(bytes) {
  return Number((bytes / 1024).toFixed(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = runFrontendPerformanceGate();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      initialJavaScript: {
        requests: report.initialJavaScript.length,
        rawKiB: kibibytes(report.initialJavaScriptRawBytes),
        gzipKiB: kibibytes(report.initialJavaScriptGzipBytes),
      },
      initialCss: { gzipKiB: kibibytes(report.initialCssGzipBytes) },
      lazyFeatureChunks: report.dynamicFeatures.length,
      largestFeatureRoute: report.dynamicFeatures[0]
        ? {
            name: report.dynamicFeatures[0].name,
            requests: report.dynamicFeatures[0].routeRequests,
            gzipKiB: kibibytes(report.dynamicFeatures[0].routeGzip),
          }
        : null,
      budgets: {
        initialJavaScriptRawKiB: kibibytes(FRONTEND_PERFORMANCE_BUDGETS.initialJavaScriptRawBytes),
        initialJavaScriptGzipKiB: kibibytes(FRONTEND_PERFORMANCE_BUDGETS.initialJavaScriptGzipBytes),
        initialJavaScriptRequests: FRONTEND_PERFORMANCE_BUDGETS.initialJavaScriptRequests,
        initialCssGzipKiB: kibibytes(FRONTEND_PERFORMANCE_BUDGETS.initialCssGzipBytes),
        largestFeatureChunkGzipKiB: kibibytes(FRONTEND_PERFORMANCE_BUDGETS.largestFeatureChunkGzipBytes),
        largestFeatureRouteGzipKiB: kibibytes(FRONTEND_PERFORMANCE_BUDGETS.largestFeatureRouteGzipBytes),
        largestFeatureRouteRequests: FRONTEND_PERFORMANCE_BUDGETS.largestFeatureRouteRequests,
      },
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
