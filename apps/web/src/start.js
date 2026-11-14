import { createStart } from "@tanstack/react-start";

// No request middleware: API authentication happens in the proxy server
// function, which attaches the server-held bearer token per call.
export const startInstance = createStart(() => ({
  requestMiddleware: [],
  functionMiddleware: [],
}));
