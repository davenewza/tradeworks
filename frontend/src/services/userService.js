import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class UserService {
  constructor() {
    this.baseUrl = API_BASE
    // In-memory cache for users
    this.userCache = new Map()
    // In-flight request tracking to prevent duplicate requests
    this.pendingRequests = new Map()
  }

  async makeRequest(endpoint, data = null) {
    const url = `${this.baseUrl}${endpoint}`
    const headers = { 'Content-Type': 'application/json' }
    const token = authService.getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    })

    if (!response.ok) {
      let message = `HTTP error ${response.status}`
      try {
        const err = await response.json()
        if (err?.message) message = err.message
      } catch {}
      if (typeof message === 'string' && message.toLowerCase().includes('token has expired')) {
        authService.logout()
        window.location.reload()
      }
      throw new Error(message)
    }

    return response.json()
  }

  async getUser(id, useCache = true) {
    // Check cache first if caching is enabled
    if (useCache && this.userCache.has(id)) {
      return this.userCache.get(id)
    }

    // Check if there's already a pending request for this user ID
    if (this.pendingRequests.has(id)) {
      // Wait for the existing request to complete
      return this.pendingRequests.get(id)
    }

    // Create a new request and store the promise
    const requestPromise = this.makeRequest('/getUser', { id })
      .then(user => {
        // Store in cache
        this.userCache.set(id, user)
        // Clean up pending request
        this.pendingRequests.delete(id)
        return user
      })
      .catch(error => {
        // Clean up pending request on error
        this.pendingRequests.delete(id)
        throw error
      })

    // Store the pending promise
    this.pendingRequests.set(id, requestPromise)

    return requestPromise
  }

  // Clear user cache (useful when users are updated)
  clearUserCache(userId = null) {
    if (userId) {
      this.userCache.delete(userId)
    } else {
      this.userCache.clear()
    }
  }
}

export const userService = new UserService()


