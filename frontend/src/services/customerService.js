const API_BASE = '/api/json'

class CustomerService {
  async makeRequest(endpoint, data = null) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: data ? JSON.stringify(data) : undefined,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.message || `HTTP error! status: ${response.status}`)
    }

    return response.json()
  }

  // Get a specific customer
  async getCustomer(customerId) {
    return await this.makeRequest('/getCustomer', { id: customerId })
  }
}

export const customerService = new CustomerService()
