import { createConvexStore } from "./convexStore.mjs";
import { createFileStore } from "./fileStore.mjs";

export async function createConfiguredStore(config) {
  if (config.storageProvider === "convex") {
    return await createConvexStore(config);
  }
  if (config.dataFile) {
    return await createFileStore(config.dataFile, {
      t3TokenEncryptionKey: config.t3TokenEncryptionKey,
      pushEncryptionKey: config.webPushEncryptionKey,
    });
  }
  return undefined;
}
