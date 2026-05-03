document.addEventListener('DOMContentLoaded', () => {
        const loginForm = document.getElementById('loginForm');
        const loginError = document.getElementById('loginError');
    
        // Redirect if already logged in (common.js might handle this too, but good to have here)
        if (getToken() && window.location.pathname === '/login') {
             // Verify token validity before redirecting
            fetchWithAuth(`${API_BASE_URL}/auth/users/me`)
            .then(response => {
                if (response.ok) {
                    window.location.href = '/dashboard';
                } else {
                    removeToken(); // Invalid token
                }
            }).catch(() => removeToken());
        }

        if (loginForm) {
            loginForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                loginError.textContent = '';
    
                const formData = new FormData(loginForm);
                // FastAPI OAuth2PasswordRequestForm expects x-www-form-urlencoded
                const params = new URLSearchParams();
                for (const pair of formData) {
                    params.append(pair[0], pair[1]);
                }
    
                try {
                    const response = await fetch(`${API_BASE_URL}/auth/token`, {
                        method: 'POST',
                        body: params,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        }
                    });
    
                    if (response.ok) {
                        const data = await response.json();
                        setToken(data.access_token);
                        const userResponse = await fetchWithAuth(`${API_BASE_URL}/auth/users/me`);
                        if (userResponse.ok) {
                            const userData = await userResponse.json();
                            localStorage.setItem('userRole', userData.role);
                        }
                        window.location.href = '/dashboard';
                    } else {
                        let msg = 'Incorrect email or password';
                        try {
                            const errData = await response.json();
                            if (errData.detail) msg = errData.detail;
                        } catch(e) {}
                        loginError.textContent = msg;
                    }
                } catch (error) {
                    console.error('Login error:', error);
                    loginError.textContent = 'Server error. Please try again later.';
                }
            });
        }
    });