import { METHODS } from "node:http";
import supertest from "supertest";

type ListenerApi = Record<string, unknown>;
type RequestMethod = (url: string) => supertest.Test;
function useBoundListener<T extends object>(api: T) {
  for (const method of [...METHODS.map((name) => name.toLowerCase()), "del"]) {
    if (typeof (api as ListenerApi)[method] !== "function") continue;
    const original = (api as ListenerApi)[method] as RequestMethod;
    (api as ListenerApi)[method] = function (
      this: T,
      ...args: Parameters<RequestMethod>
    ) {
      const test = original.apply(this, args);
      const server = test.app as {
        address?: () => import("node:net").AddressInfo | null;
      };
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

function request(...args: Parameters<typeof supertest>) {
  return useBoundListener(supertest(...args));
}

Object.assign(request, supertest);
request.agent = (...args: Parameters<typeof supertest.agent>) =>
  useBoundListener(supertest.agent(...args));

export default request;
