import { METHODS } from "node:http";
import supertest from "supertest";

function useBoundListener(api) {
  for (const method of [...METHODS.map((name) => name.toLowerCase()), "del"]) {
    if (typeof api[method] !== "function") continue;
    const original = api[method];
    api[method] = function (...args) {
      const test = original.apply(this, args);
      const server = test.app;
      const address =
        typeof server?.address === "function" ? server.address() : null;
      // Supertest listens on :: by default but constructs a 127.0.0.1 URL.
      // Match the actual listener; an IPv4 forward on the same port is unrelated.
      // Keep the URL/Host unchanged so its cookie jar retains the same origin.
      if (address?.family === "IPv6") {
        test.connect({ "127.0.0.1": "::1" });
      }
      return test;
    };
  }
  return api;
}

function request(...args) {
  return useBoundListener(supertest(...args));
}

Object.assign(request, supertest);
request.agent = (...args) => useBoundListener(supertest.agent(...args));

export default request;
