import { RequestHandler, Response, NextFunction } from "express";
import { AuthProvider, AuthenticatedRequest } from "../auth/types";

/**
 * Resolves the `AuthProvider` and stamps `tenantId`/`scopes` onto the request.
 * A null result means the provider rejected the request — 401.
 */
export function tenantMiddleware(provider: AuthProvider): RequestHandler {
  // SECURITY-REVIEW: tenant resolution — relies on AuthProvider correctness
  return async (req, res: Response, next: NextFunction) => {
    try {
      const principal = await provider.authenticate(req);
      if (!principal) {
        res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
        return;
      }
      (req as AuthenticatedRequest).tenantId = principal.tenantId;
      (req as AuthenticatedRequest).scopes = principal.scopes;
      next();
    } catch (err) {
      next(err);
    }
  };
}
