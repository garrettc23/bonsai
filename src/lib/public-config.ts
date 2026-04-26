/**
 * Public branding surface for the unauthenticated GET /api/public-config
 * endpoint. The SPA, landing page, and error pages render the operator's
 * support email + public domain from this — keeping the values out of the
 * source so OSS forks and the canonical deployment configure independently.
 *
 * Reads at request time (not boot) so a Railway env-var change picked up
 * on next deploy is reflected without us caching a stale value.
 */
export interface PublicConfig {
  support_email: string | null;
  public_domain: string | null;
}

export function readPublicConfig(): PublicConfig {
  const support_email = process.env.BONSAI_SUPPORT_EMAIL?.trim() || null;
  const public_domain = process.env.BONSAI_PUBLIC_DOMAIN?.trim() || null;
  return { support_email, public_domain };
}

export function handlePublicConfig(): Response {
  return Response.json(readPublicConfig());
}
