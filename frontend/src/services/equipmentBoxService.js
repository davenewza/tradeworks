import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class EquipmentBoxService {
  constructor() {
    this.baseUrl = API_BASE
    // In-memory cache for equipment boxes
    this.equipmentBoxCache = new Map()
  }

  async makeRequest(endpoint, data = null) {
    const url = `${this.baseUrl}${endpoint}`
    const headers = {
      'Content-Type': 'application/json',
    }
    
    // Add authentication header if available
    const token = authService.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    
    const options = {
      method: data ? 'POST' : 'GET',
      headers,
    }

    if (data) {
      options.body = JSON.stringify(data)
    }

    const response = await fetch(url, options)
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const message = errorData.message || `HTTP error! status: ${response.status}`
      if (typeof message === 'string' && message.toLowerCase().includes('token has expired')) {
        authService.logout()
        window.location.reload()
      }
      throw new Error(message)
    }

    return response.json()
  }

  // Calculate equipment boxes for a quote
  async calculateEquipmentBoxes(quoteId, boxType) {
    return this.makeRequest('/calculateEquipmentBoxes', { id: quoteId, boxType: boxType })
  }

  // Reset delivery info for a quote
  async resetDeliveryInfo(quoteId) {
    return this.makeRequest('/resetDeliveryInfo', { id: quoteId })
  }

  // List equipment boxes for a quote
  async listQuoteEquipmentBoxes(quoteId) {
    return this.makeRequest('/listQuoteEquipmentBoxes', {
      where: {
        quote: {
          id: {
            equals: quoteId
          }
        }
      }
    })
  }

  // Get equipment box details (with caching)
  async getEquipmentBox(equipmentBoxId, useCache = true) {
    // Check cache first if caching is enabled
    if (useCache && this.equipmentBoxCache.has(equipmentBoxId)) {
      return this.equipmentBoxCache.get(equipmentBoxId)
    }

    // Fetch from API
    const equipmentBox = await this.makeRequest('/getEquipmentBox', { id: equipmentBoxId })

    // Store in cache
    this.equipmentBoxCache.set(equipmentBoxId, equipmentBox)

    return equipmentBox
  }

  // Clear equipment box cache (useful when equipment boxes are updated)
  clearEquipmentBoxCache(equipmentBoxId = null) {
    if (equipmentBoxId) {
      this.equipmentBoxCache.delete(equipmentBoxId)
    } else {
      this.equipmentBoxCache.clear()
    }
  }

  // List all equipment boxes
  async listEquipmentBoxes() {
    return this.makeRequest('/listEquipmentBoxes')
  }
}

export const equipmentBoxService = new EquipmentBoxService()
