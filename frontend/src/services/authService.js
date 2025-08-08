import { API_BASE } from '../config/api.js'

class AuthService {
  constructor() {
    this.baseUrl = API_BASE
    this.tokenKey = 'auth_token'
    this.userKey = 'auth_user'
  }

  // Get stored token
  getToken() {
    return localStorage.getItem(this.tokenKey)
  }

  // Set token in localStorage
  setToken(token) {
    localStorage.setItem(this.tokenKey, token)
  }

  // Remove token from localStorage
  removeToken() {
    localStorage.removeItem(this.tokenKey)
    localStorage.removeItem('refresh_token')
  }

  // Get stored user
  getUser() {
    const userStr = localStorage.getItem(this.userKey)
    return userStr ? JSON.parse(userStr) : null
  }

  // Set user in localStorage
  setUser(user) {
    localStorage.setItem(this.userKey, JSON.stringify(user))
  }

  // Remove user from localStorage
  removeUser() {
    localStorage.removeItem(this.userKey)
  }

  // Check if user is authenticated
  isAuthenticated() {
    return !!this.getToken()
  }

  // Login with email and password
  async login(email, password) {
    try {
      if (!email || !password) {
        throw new Error('Email and password are required')
      }

      // Use Keel's authentication endpoint
      const formData = new URLSearchParams()
      formData.append('grant_type', 'password')
      formData.append('username', email)
      formData.append('password', password)

      const response = await fetch(`${this.baseUrl.replace('/api/json', '')}/auth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || errorData.error_description || 'Login failed')
      }

      const data = await response.json()
      
      // Store the access token
      this.setToken(data.access_token)
      
      // Store refresh token if needed for future use
      if (data.refresh_token) {
        localStorage.setItem('refresh_token', data.refresh_token)
      }
      
      // Return data with identity_created flag to determine if profile completion is needed
      return data
    } catch (error) {
      console.error('Login error:', error)
      throw error
    }
  }

  // Get user record using getMe
  async getCurrentUser() {
    try {
      const response = await fetch(`${this.baseUrl}/getMe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`,
        },
      })

      if (response.ok) {
        const user = await response.json()
        if (user) {
          this.setUser(user)
          return user
        } else {
          // If getMe returns null, try to create the user
          console.log('getMe returned null, creating user...')
          return await this.createUser()
        }
      } else {
        throw new Error('Failed to get user')
      }
    } catch (error) {
      console.error('Error getting user:', error)
      throw error
    }
  }

  // Create user record using createMe (without profile data)
  async createUser() {
    try {
      const response = await fetch(`${this.baseUrl}/createMe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`,
        },
      })

      if (response.ok) {
        const user = await response.json()
        this.setUser(user)
        return user
      } else {
        throw new Error('Failed to create user')
      }
    } catch (error) {
      console.error('Error creating user:', error)
      throw error
    }
  }

  // Create user with firstName and lastName
  async createUserWithProfile(firstName, lastName) {
    try {
      const response = await fetch(`${this.baseUrl}/createMe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`,
        },
        body: JSON.stringify({
          firstName,
          lastName,
        }),
      })

      if (response.ok) {
        const user = await response.json()
        this.setUser(user)
        return user
      } else {
        throw new Error('Failed to create user with profile')
      }
    } catch (error) {
      console.error('Error creating user with profile:', error)
      throw error
    }
  }

  // Get customerId from user data
  getCustomerId(user) {
    return user?.customerId || null
  }

  // Logout
  logout() {
    this.removeToken()
    this.removeUser()
  }

  // Request password reset
  async requestPasswordReset(email, redirectUrl) {
    try {
      const response = await fetch(`${this.baseUrl}/requestPasswordReset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          redirectUrl,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || 'Password reset request failed')
      }

      return await response.json()
    } catch (error) {
      console.error('Password reset request error:', error)
      throw error
    }
  }

  // Reset password with token
  async resetPassword(token, password) {
    try {
      const response = await fetch(`${this.baseUrl}/resetPassword`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token,
          password,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || 'Password reset failed')
      }

      return await response.json()
    } catch (error) {
      console.error('Password reset error:', error)
      throw error
    }
  }

  // Refresh access token using refresh token
  async refreshToken() {
    try {
      const refreshToken = localStorage.getItem('refresh_token')
      if (!refreshToken) {
        throw new Error('No refresh token available')
      }

      const formData = new URLSearchParams()
      formData.append('grant_type', 'refresh_token')
      formData.append('refresh_token', refreshToken)

      const response = await fetch(`${this.baseUrl.replace('/api/json', '')}/auth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || errorData.error_description || 'Token refresh failed')
      }

      const data = await response.json()
      
      // Store the new access token
      this.setToken(data.access_token)
      
      // Update refresh token if a new one is provided
      if (data.refresh_token) {
        localStorage.setItem('refresh_token', data.refresh_token)
      }
      
      return data
    } catch (error) {
      console.error('Token refresh error:', error)
      // If refresh fails, clear tokens and force re-login
      this.logout()
      throw error
    }
  }

  // Get authenticated user info (cached version)
  async getCurrentUserCached() {
    if (!this.isAuthenticated()) {
      return null
    }

    try {
      const user = this.getUser()
      if (user) {
        return user
      }

      // If no user in localStorage, try to get one from API
      return await this.getCurrentUser()
    } catch (error) {
      console.error('Error getting current user:', error)
      return null
    }
  }
}

export const authService = new AuthService()
