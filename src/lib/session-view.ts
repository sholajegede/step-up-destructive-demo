import { toClaimsView, type ClaimsView } from "./claims-view";
import { verifyAccessToken, verifyIdToken } from "./jwt";
import { readSession } from "./session";

export type SessionView = {
  signedIn: boolean;
  accessToken?: ClaimsView;
  idToken?: ClaimsView;
  accessTokenError?: string;
  idTokenError?: string;
  hasRefreshToken?: boolean;
};

/**
 * Builds the readable view of the signed-in person's claims.
 *
 * Both tokens are re-verified here rather than trusted from the cookie, so
 * what is shown is what a verifier would accept. No token material is
 * included in the result.
 */
export async function getSessionView(): Promise<SessionView> {
  const session = await readSession();
  if (session === null) {
    return { signedIn: false };
  }

  const view: SessionView = {
    signedIn: true,
    hasRefreshToken: session.refreshToken !== undefined,
  };

  try {
    view.accessToken = toClaimsView(await verifyAccessToken(session.accessToken));
  } catch (error) {
    view.accessTokenError =
      error instanceof Error ? error.message : "Access token invalid.";
  }

  if (session.idToken !== undefined) {
    try {
      view.idToken = toClaimsView(await verifyIdToken(session.idToken));
    } catch (error) {
      view.idTokenError =
        error instanceof Error ? error.message : "ID token invalid.";
    }
  }

  return view;
}
