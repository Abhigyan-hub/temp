import dns from "node:dns";

// Node on this machine resolves through 127.0.0.1, which refuses MongoDB SRV lookups.
// Windows' own resolver still works, so point Node at public DNS before the app loads.
const servers = dns.getServers();
const loopbackOnly = servers.every((server) => server === "127.0.0.1" || server === "::1");
if (loopbackOnly) dns.setServers(["8.8.8.8", "1.1.1.1"]);
