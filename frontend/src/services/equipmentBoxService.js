import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class EquipmentBoxService {
  constructor() {
    this.baseUrl = API_BASE
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
      const errorData = await response.json()
      throw new Error(errorData.message || `HTTP error! status: ${response.status}`)
    }

    return response.json()
  }

  // Calculate equipment boxes for a quote
  async calculateEquipmentBoxes(quoteId, boxType) {
    return this.makeRequest('/calculateEquipmentBoxes', { id: quoteId, boxType: boxType })
  }

  // Remove equipment boxes for a quote
  async removeEquipmentBoxes(quoteId) {
    return this.makeRequest('/removeEquipmentBoxes', { id: quoteId })
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

  // Get equipment box details
  async getEquipmentBox(equipmentBoxId) {
    return this.makeRequest('/getEquipmentBox', { id: equipmentBoxId })
  }

  // List all equipment boxes
  async listEquipmentBoxes() {
    return this.makeRequest('/listEquipmentBoxes')
  }
}

export const equipmentBoxService = new EquipmentBoxService()
