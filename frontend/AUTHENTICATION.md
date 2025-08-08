# Authentication Implementation

This document explains the authentication implementation in the TradeWorks frontend and how to properly configure Keel authentication.

## Current Implementation

The frontend includes a complete authentication system with:

### Components
- **LoginForm.vue**: Login form with email/password authentication
- **ResetPassword.vue**: Password reset form for token-based password reset
- **App.vue**: Updated to handle authentication state and show login/logout

### Services
- **authService.js**: Handles all authentication operations including:
  - Login/logout
  - Token management
  - User creation/retrieval
  - Password reset functionality

### Features
- ✅ Login form with email/password
- ✅ Password reset functionality
- ✅ Token-based authentication
- ✅ Automatic token inclusion in API requests
- ✅ User session management
- ✅ Logout functionality

## Keel Authentication Configuration

To properly configure Keel authentication, you need to:

### 1. Configure Keel Authentication

According to the [Keel documentation](https://docs.keel.so/), you need to configure authentication in your `keelconfig.yaml` file:

```yaml
authentication:
  password:
    enabled: true
    email:
      from: "noreply@yourdomain.com"
      subject: "Password Reset"
```

### 2. Update Backend Schema

Ensure your backend schema includes the proper authentication models:

```keel
model User {
  fields {
    identity Identity @unique 
  }
  actions {
    create createMe() {
      @set(user.identity = ctx.identity)
    }
  }
  @permission(expression: ctx.isAuthenticated, actions:[create])
}
```

### 3. Enable Authentication Endpoints

The backend should expose standard authentication endpoints:
- `/auth/login` - For email/password login
- `/auth/register` - For user registration
- `/auth/logout` - For logout

### 4. Update Frontend Authentication Service

Once the backend is properly configured, update the `authService.js` login method:

```javascript
async login(email, password) {
  try {
    const response = await fetch(`${this.baseUrl.replace('/api/json', '')}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.message || 'Login failed')
    }

    const data = await response.json()
    this.setToken(data.token)
    await this.createOrGetUser()
    return data
  } catch (error) {
    console.error('Login error:', error)
    throw error
  }
}
```

## Current Implementation

The current implementation uses Keel's proper authentication system:

1. **Uses `/auth/token` endpoint** for email/password authentication
2. **Supports automatic user creation** if the user doesn't exist
3. **Profile completion dialog** for new users to enter firstName and lastName
4. **Automatic customer ID retrieval** from user profile
5. **Handles access tokens and refresh tokens** properly
6. **Includes authentication headers** in all API requests
7. **Supports token refresh** for extended sessions

### Authentication Endpoint Details

**Login Endpoint**: `POST /auth/token`

**Request Format**:
```
Content-Type: application/x-www-form-urlencoded

grant_type=password
username={{email}}
password={{password}}
```

**Response Format**:
```json
{
  "access_token": "{{keel_access_token}}",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "{{keel_refresh_token}}",
  "identity_created": false
}
```

**Token Refresh Endpoint**: `POST /auth/token`

**Request Format**:
```
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
refresh_token={{refresh_token}}
```

### Profile Completion Flow

**For New Users**:
1. User logs in with email/password
2. If `identity_created: true`, show profile completion dialog
3. User enters firstName and lastName
4. Call `createMe` with profile data
5. Retrieve customerId from user response
6. Show main application or "No Customer Assigned" message

**For Existing Users**:
1. User logs in with email/password
2. If `identity_created: false`, get existing user profile via `getMe`
3. If `getMe` returns null, create user via `createMe`
4. Retrieve customerId from user response
5. Show main application or "No Customer Assigned" message

### Customer ID Retrieval

The application now automatically retrieves the customer ID from the user profile instead of requiring it as a URL query parameter:

- **Source**: User profile data from `getMe` or `createMe` endpoints
- **Field**: `user.customer.id` from the user response
- **Fallback**: Shows "No Customer Assigned" message if no customer is assigned
- **Security**: Customer assignment is controlled by the backend user management

## Testing the Authentication

1. **Start the application**: `npm run dev`
2. **Navigate to the app**: The login form will appear (no URL parameters needed)
3. **Enter valid credentials**: Use real email/password or create a new account
4. **Complete profile** (for new users): Enter firstName and lastName when prompted
5. **Access the main application**: After successful login, you'll see the main app with logout button
6. **Customer assignment**: The system will automatically show your assigned customer data or indicate if none is assigned
7. **Test token refresh**: The system automatically handles token refresh for extended sessions

## Production Deployment

For production deployment:

1. **Configure Keel authentication** properly in the backend
2. **Set up proper email configuration** for password reset
3. **Configure environment variables** for authentication settings
4. **Test the complete authentication flow** before deployment
5. **Ensure HTTPS is enabled** for secure token transmission

## Security Considerations

- The current implementation uses **proper Keel authentication**
- Always use HTTPS in production for secure token transmission
- Implement proper password validation and security measures
- Consider implementing rate limiting for login attempts
- Add proper error handling and logging
- Store tokens securely and handle token expiration properly

## Next Steps

1. Configure Keel authentication in the backend (if not already done)
2. Test the complete authentication flow with real credentials
3. Set up email configuration for password reset functionality
4. Deploy with proper security measures and HTTPS
