

const GOOGLE_CLIENT_ID = "1091020076619-hq562icl6hn976plma463rdmssi6nbfq.apps.googleusercontent.com";

/**
 * Renders the "Continue with Google" button into `container`.
 *
 * @param {HTMLElement} container   Element to render the button into.
 * @param {Function|null} getRole   Called at click-time to read the currently
 *                                  selected role ("student" | "teacher").
 *                                  Pass null on the login page, where the
 *                                  role isn't chosen — the backend will
 *                                  return whichever role the account has.
 * @param {Function} onError        Called with a friendly message on failure.
 */
function initGoogleSignIn(container, getRole, onError) {
  if (!window.google || !window.google.accounts) {
    // gsi client script hasn't loaded yet — retry shortly rather than
    // silently failing to render a button.
    setTimeout(() => initGoogleSignIn(container, getRole, onError), 200);
    return;
  }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response) => handleGoogleCredential(response, getRole, onError),
  });

  google.accounts.id.renderButton(container, {
    type: "standard",
    theme: "outline",
    size: "large",
    shape: "pill",
    text: getRole ? "signup_with" : "signin_with",
    logo_alignment: "left",
    width: container.offsetWidth || 360,
  });
}

async function handleGoogleCredential(response, getRole, onError) {
  try {
    const payload = { credential: response.credential };
    if (getRole) payload.role = getRole();

    const data = await apiRequest("/api/auth/google", "POST", payload);
    saveSession(data.user, data.token);

    window.location.href =
      data.user.role === "teacher" ? "teacher-dashboard.html" : "student-dashboard.html";
  } catch (err) {
    onError(err.message || "Google sign-in didn't go through. Please try again.");
  }
}