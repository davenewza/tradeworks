<template>
  <div id="app" class="min-h-screen bg-gray-50">
    <!-- Authentication Check -->
    <div v-if="!isAuthenticated" class="min-h-screen">
      <div class="max-w-6xl mx-auto px-4 py-0">
        <LoginForm @login-success="handleLoginSuccess" />
      </div>
    </div>
    
    <!-- Profile Completion Dialog -->
    <UserProfileDialog 
      v-if="showProfileDialog" 
      :show="showProfileDialog"
      @profile-saved="handleProfileSaved"
      @cancel="handleProfileCancel"
    />
    
    <!-- Main Application -->
    <div v-else-if="isAuthenticated && !showProfileDialog" class="max-w-6xl mx-auto px-4 py-8">
      <header class="mb-8">
        <div class="flex justify-between items-center">
          <div>
            <div class="flex items-center gap-3 mb-1">
              <img v-if="logoOk" :src="logoSrc" alt="CREATESPACE" class="h-10 md:h-7 w-auto" @error="logoOk = false" />
              <h1 v-else class="text-3xl font-bold text-gray-900">CREATESPACE</h1>
            </div>
          </div>
          <div class="flex items-center space-x-4">
            <span class="text-sm text-gray-600">
              Welcome, {{ welcomeText }}
            </span>
            <button
              v-if="hasCustomerId"
              @click="showAddresses = true"
              class="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 border border-blue-200"
            >
              Manage Delivery Addresses
            </button>
            <button
              @click="handleLogout"
              class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
            >
              Logout
            </button>
          </div>
        </div>
      </header>
      
      <!-- Loading State -->
      <div v-if="isLoadingUser" class="flex justify-center items-center py-20">
        <div class="text-center">
          <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p class="text-gray-600">Loading...</p>
        </div>
      </div>

      <!-- Customer Assignment Check -->
      <div v-else-if="!hasCustomerId" class="card text-center py-12">
        <div class="text-yellow-600 text-lg font-medium mb-2">No Customer Assigned</div>
        <p class="text-gray-600 mb-4">No customer has been assigned to you yet. Please contact your administrator.</p>
      </div>

      <!-- Main Application Content -->
      <PriceListManager
        v-else-if="hasCustomerId && !showAddresses"
        :customer-id="customerId"
        :key="`price-list-manager-${customerId}`"
      />
      <DeliveryAddresses
        v-else-if="hasCustomerId && showAddresses"
        :customer-id="customerId"
        @close="showAddresses = false"
      />
    </div>
  </div>
</template>

<script>
import PriceListManager from './components/PriceListManager.vue'
import LoginForm from './components/LoginForm.vue'
import UserProfileDialog from './components/UserProfileDialog.vue'
import DeliveryAddresses from './components/DeliveryAddresses.vue'
import { authService } from './services/authService.js'
import { customerService } from './services/customerService.js'

export default {
  name: 'App',
  components: {
    PriceListManager,
    LoginForm,
    UserProfileDialog,
    DeliveryAddresses
  },
  data() {
    return {
      isAuthenticated: false,
      currentUser: null,
      showProfileDialog: false,
      loginData: null,
      customerId: null,
      showAddresses: false,
      logoOk: true,
      logoSrc: `${import.meta.env.BASE_URL}createspace-logo.png`,
      customerName: '',
      isLoadingUser: false
    }
  },
  computed: {
    hasCustomerId() {
      return !!this.customerId
    },
    welcomeText() {
      const user = this.currentUser?.firstName || this.currentUser?.id || 'User'
      return this.customerName ? `${user} (${this.customerName})` : user
    }
  },
  async mounted() {
    // Handle SSO redirect (authorization code)
    try {
      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')
      if (code && !authService.isAuthenticated()) {
        await authService.exchangeAuthorizationCode(code)
        // Clean the URL
        const url = new URL(window.location.href)
        url.searchParams.delete('code')
        window.history.replaceState({}, '', url.toString())
      }
    } catch (e) {
      console.error('SSO exchange failed:', e)
    }

    // Check authentication status
    this.isAuthenticated = authService.isAuthenticated()

    if (this.isAuthenticated) {
      // Set loading state while fetching user data
      this.isLoadingUser = true

      // Always refetch user data on page refresh to ensure we have the latest information
      try {
        this.currentUser = await authService.getCurrentUser()
        this.customerId = authService.getCustomerId(this.currentUser)
        await this.loadCustomerName()
        console.log('User data refreshed on page load:', this.currentUser)
        console.log('Customer ID refreshed on page load:', this.customerId)
      } catch (error) {
        console.error('Failed to refresh user data on page load:', error)
        // If we can't get fresh user data, try to use cached data
        this.currentUser = await authService.getCurrentUserCached()
        this.customerId = authService.getCustomerId(this.currentUser)
        await this.loadCustomerName()
      } finally {
        this.isLoadingUser = false
      }
    }
  },
  methods: {
    async handleLoginSuccess(loginData) {
      console.log('Login successful:', loginData)
      this.isAuthenticated = true
      this.loginData = loginData

      // Check if this is a new user (identity_created: true)
      if (loginData.identity_created) {
        console.log('New user detected, showing profile dialog')
        // Show profile completion dialog for new users
        this.showProfileDialog = true
      } else {
        console.log('Existing user, retrieving profile')
        // Set loading state while fetching user data
        this.isLoadingUser = true
        try {
          // Existing user, get their profile
          this.currentUser = await authService.getCurrentUser()
          this.customerId = authService.getCustomerId(this.currentUser)
          await this.loadCustomerName()
        } finally {
          this.isLoadingUser = false
        }
      }
    },
    
    async handleProfileSaved(profileData) {
      console.log('Profile data received:', profileData)
      try {
        // Create user with firstName and lastName
        this.currentUser = await authService.createUserWithProfile(
          profileData.firstName, 
          profileData.lastName
        )
        console.log('User created with profile:', this.currentUser)
        this.customerId = authService.getCustomerId(this.currentUser)
        await this.loadCustomerName()
        this.showProfileDialog = false
      } catch (error) {
        console.error('Failed to save profile:', error)
        // You might want to show an error message to the user here
      }
    },
    
    handleProfileCancel() {
      // If user cancels profile completion, log them out
      this.handleLogout()
    },
    
    handleLogout() {
      authService.logout()
      this.isAuthenticated = false
      this.currentUser = null
      this.showProfileDialog = false
      this.loginData = null
      this.customerId = null
      this.customerName = ''
    },
    async loadCustomerName() {
      try {
        if (!this.customerId) return
        const customer = await customerService.getCustomer(this.customerId)
        this.customerName = customer?.name || customer?.companyName || ''
      } catch (e) {
        console.warn('Failed to load customer name', e)
        this.customerName = ''
      }
    }
  }
}
</script>
