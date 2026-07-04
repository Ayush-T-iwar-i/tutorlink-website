// ===========================================
// TutorLink — Google Sign-In helper
// Used by both login.html and signup.html
// ===========================================

// Renders the Google button if a Client ID is configured on the server.
// getRoleFn: a function returning "student" or "teacher" (signup page only, pass null on login)
async function initGoogleSignIn(container, getRoleFn, onError) {
  try {
    const config = await apiRequest('/api/config');

    if (!config.googleClientId) {
      container.innerHTML = '<div class="google-unavailable">Google sign-in is not set up yet on this server.</div>';
      return;
    }

    // Wait for the Google script (loaded via <script> tag in the page) to be ready
    if (!window.google || !window.google.accounts) {
      container.innerHTML = '<div class="google-unavailable">Could not load Google sign-in. Check your internet connection.</div>';
      return;
    }

    window.google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: async (response) => {
        try {
          const role = getRoleFn ? getRoleFn() : undefined;
          const data = await apiRequest('/api/auth/google', 'POST', {
            credential: response.credential,
            role
          });
          saveSession(data.user, data.token);
          window.location.href = data.user.role === 'teacher' ? 'teacher-dashboard.html' : 'student-dashboard.html';
        } catch (err) {
          onError(err.message);
        }
      }
    });

    window.google.accounts.id.renderButton(container, {
      theme: 'outline',
      size: 'large',
      width: 320,
      text: 'continue_with'
    });
  } catch (err) {
    container.innerHTML = '<div class="google-unavailable">Google sign-in unavailable right now.</div>';
  }
}
