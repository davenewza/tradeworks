# Authentication Flow Test Guide

## Testing New User Registration with Profile Completion

### Prerequisites
1. Backend server running on `http://localhost:8000`
2. Frontend application built and running
3. Valid user account (no URL parameters required)

### Test Steps

#### 1. Test New User Registration
1. **Open the application** in your browser (no URL parameters needed)
2. **Enter new credentials** (email/password that hasn't been used before)
3. **Submit the login form**
4. **Verify the response** contains `"identity_created": true`
5. **Check console logs** for:
   - "Login successful: [loginData]"
   - "New user detected, showing profile dialog"

#### 2. Test Profile Completion Dialog
1. **Verify the profile dialog appears** after successful login
2. **Enter firstName and lastName** in the form
3. **Submit the profile form**
4. **Check console logs** for:
   - "Profile data received: [profileData]"
   - "User created with profile: [userData]"
   - "Customer ID: [customerId]"

#### 3. Test Existing User Login
1. **Logout** from the application
2. **Login with the same credentials** used in step 1
3. **Verify the response** contains `"identity_created": false`
4. **Check console logs** for:
   - "Login successful: [loginData]"
   - "Existing user, retrieving profile"

#### 4. Test Customer Assignment
1. **For users with customer assignment**: Verify the main application loads with their customer data
2. **For users without customer assignment**: Verify the "No Customer Assigned" message appears
3. **Verify automatic retrieval**: Customer ID is retrieved from user profile, not URL parameters

### Expected Behavior

#### New User Flow
```
Login Form → Authentication → Profile Dialog → User Creation → Main App/Customer Check
```

#### Existing User Flow
```
Login Form → Authentication → Profile Retrieval → Main App/Customer Check
```

### Debug Information

The application includes console logging to help debug the flow:

- **Login success**: Shows the complete login response
- **User type detection**: Indicates if user is new or existing
- **Profile data**: Shows the firstName/lastName being saved
- **User creation**: Shows the created user object
- **Customer ID**: Shows the extracted customer ID

### Common Issues

1. **Profile dialog doesn't appear**: Check if `identity_created` is `true` in login response
2. **Profile creation fails**: Check network tab for API errors
3. **Customer ID is null**: User may not be assigned to a customer
4. **Login fails**: Verify backend authentication endpoint is working

### API Endpoints Used

- `POST /auth/token` - Authentication
- `POST /api/json/getMe` - User profile retrieval
- `POST /api/json/createMe` - User creation (fallback when getMe returns null)
- `POST /api/json/createMe` - User creation with profile (for new users)
