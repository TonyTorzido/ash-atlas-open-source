import { createApplication } from "./application.js";

async function main(): Promise<void> {
  const application = await createApplication();
  let shutdownPromise: Promise<boolean> | null = null;
  let fatalShutdown = false;
  const requestShutdown = (signal: string, fatal: boolean): void => {
    fatalShutdown ||= fatal;
    shutdownPromise ??= application.shutdown(signal);
    void shutdownPromise.then(
      (durable) => process.exit(durable && !fatalShutdown ? 0 : 1),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      }
    );
  };

  process.once("SIGINT", () => requestShutdown("SIGINT", false));
  process.once("SIGTERM", () => requestShutdown("SIGTERM", false));
  process.once("uncaughtException", (error, origin) => {
    application.reportFatal(error, origin);
    requestShutdown("uncaughtException", true);
  });
  process.once("unhandledRejection", (reason) => {
    application.reportFatal(reason, "unhandledRejection");
    requestShutdown("unhandledRejection", true);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
