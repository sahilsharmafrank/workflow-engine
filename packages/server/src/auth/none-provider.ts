import { Request } from "express";
import { AuthProvider } from "./types";

/**
 * Unauthenticated provider for v1. Tenant identity comes from the
 * `X-Tenant-Id` header, defaulting to `"default"`. Every scope is granted.
 *
 * SECURITY-REVIEW: unauthenticated — the API is open. Deployments must
 * bind to localhost or sit behind an external gateway until a real auth
 * provider lands.
 */
export class NoneAuthProvider implements AuthProvider {
  async authenticate(req: Request): Promise<{ tenantId: string; scopes: string[] }> {
    const tenantId = (req.headers["x-tenant-id"] as string) ?? "default";
    return { tenantId, scopes: ["*"] };
  }
}
