<template>
  <div id="app" class="min-h-screen bg-gray-50">
    <div class="container mx-auto px-4 py-8">
      <header class="mb-8">
        <h1 class="text-3xl font-bold text-gray-900 mb-2">TradeWorks</h1>
        <p class="text-gray-600">Price List Management System</p>
      </header>
      
      <PriceListManager v-if="defaultCustomerId" :customer-id="defaultCustomerId" />
      <div v-else class="card text-center py-12">
        <div class="text-red-600 text-lg font-medium mb-2">Error</div>
        <p class="text-gray-600 mb-4">Customer ID is required. Please provide a customerId in the URL query string.</p>
      </div>
    </div>
  </div>
</template>

<script>
import PriceListManager from './components/PriceListManager.vue'

export default {
  name: 'App',
  components: {
    PriceListManager
  },
  data() {
    return {
      defaultCustomerId: null
    }
  },
  mounted() {
    // Get customerId from URL query parameter
    const urlParams = new URLSearchParams(window.location.search)
    this.defaultCustomerId = urlParams.get('customerId')
    
    if (!this.defaultCustomerId) {
      console.error('Customer ID is required. Please provide a customerId in the URL query string.')
    }
  }
}
</script>
