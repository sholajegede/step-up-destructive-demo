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
  /**
   * The claim *names* present on each verified token — never their values.
   *
   * `ClaimsView` projects only the claims this build reasons about, so a
   * claim the provider does send could look absent simply because it is not
   * projected. Listing the names distinguishes "the provider did not send it"
   * from "we did not read it", which matters when reporting what can and
   * cannot be proved about an authentication.
   */
  claimNames?: { idToken?: string[]; accessToken?: string[] };
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

  const claimNames: { idToken?: string[]; accessToken?: string[] } = {};

  try {
    const claims = await verifyAccessToken(session.accessToken);
    view.accessToken = toClaimsView(claims);
    claimNames.accessToken = Object.keys(claims).sort();
  } catch (error) {
    view.accessTokenError =
      error instanceof Error ? error.message : "Access token invalid.";
  }

  if (session.idToken !== undefined) {
    try {
      const claims = await verifyIdToken(session.idToken);
      view.idToken = toClaimsView(claims);
      claimNames.idToken = Object.keys(claims).sort();
    } catch (error) {
      view.idTokenError =
        error instanceof Error ? error.message : "ID token invalid.";
    }
  }

  view.claimNames = claimNames;
  return view;
}
