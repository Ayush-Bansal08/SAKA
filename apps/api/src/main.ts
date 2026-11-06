/**
 * Container entry: selects the process by PROCESS_TYPE (server | worker | bot).
 * Lets one Docker image run every backend service.
 */
const processType = (process.env.PROCESS_TYPE ?? 'server').trim().toLowerCase();

switch (processType) {
  case 'server':
    await import('./server.js');
    break;
  case 'worker':
    await import('./worker.js');
    break;
  case 'bot':
    await import('./bot.js');
    break;
  default:
    console.error(`[main] Unknown PROCESS_TYPE "${processType}". Use server | worker | bot.`);
    process.exit(1);
}

export {};
