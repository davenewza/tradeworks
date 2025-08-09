import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class DeliveryAddressService {
  constructor() {
    this.baseUrl = API_BASE
  }

  async makeRequest(endpoint, data = null) {
    const url = `${this.baseUrl}${endpoint}`
    const headers = {
      'Content-Type': 'application/json',
    }

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
      let message = `HTTP error! status: ${response.status}`
      try {
        const errorData = await response.json()
        if (errorData?.message) message = errorData.message
      } catch (_) {}
      throw new Error(message)
    }
    return response.json()
  }

  async listDeliveryAddresses(customerId) {
    // Requires where.customer.id.equals
    return this.makeRequest('/listDeliveryAddresses', {
      where: {
        customer: {
          id: { equals: customerId }
        }
      }
    })
  }

  async createDeliveryAddress(address, customerId) {
    // Only send allowed fields per OpenAPI: name, addressLine1, city, province, postalCode, optional addressLine2, deliveryNotes, and customer
    const payload = {
      customer: { id: customerId },
      name: address.name,
      addressLine1: address.addressLine1,
      city: address.city,
      province: address.province,
      postalCode: address.postalCode,
    }
    if (address.addressLine2) payload.addressLine2 = address.addressLine2
    if (address.deliveryNotes) payload.deliveryNotes = address.deliveryNotes
    return this.makeRequest('/createDeliveryAddress', payload)
  }

  async updateDeliveryAddress(id, updates) {
    // Values allowed: name, addressLine1, addressLine2, deliveryNotes
    const values = {}
    if (typeof updates.name === 'string') values.name = updates.name
    if (typeof updates.addressLine1 === 'string') values.addressLine1 = updates.addressLine1
    if (typeof updates.addressLine2 === 'string') values.addressLine2 = updates.addressLine2
    if (typeof updates.deliveryNotes === 'string') values.deliveryNotes = updates.deliveryNotes
    return this.makeRequest('/updateDeliveryAddress', { where: { id }, values })
  }

  async deactivateDeliveryAddress(id) {
    return this.makeRequest('/deactivateDeliveryAddress', { where: { id } })
  }
}

export const deliveryAddressService = new DeliveryAddressService()


