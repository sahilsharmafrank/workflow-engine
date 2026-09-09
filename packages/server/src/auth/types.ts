import { Request } from "express";

/**
 * Resolves a request to a tenant identity and a set of permission scopes.
 * v1 ships only `NoneAuthProvider`; the seam exists so an `apiKey` or `jwt`
 * provider can be added later as one new file plus a config value.
 */
export interface AuthProvider {
  // SECURITY-REVIEW: auth provider interface — implementations must validate tokens/keys
  authenticate(req: Request): Promise<{ tenantId: string; scopes: string[] } | null>;
}

export interface AuthenticatedRequest extends Request {
  tenantId: string;
  scopes: string[];
}
