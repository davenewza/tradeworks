<template>
  <div id="app" class="min-h-screen bg-gray-50">
    <!-- Authentication Check -->
    <div v-if="!isAuthenticated" class="min-h-screen">
      <LoginForm @login-success="handleLoginSuccess" />
    </div>
    
    <!-- Profile Completion Dialog -->
    <UserProfileDialog 
      v-if="showProfileDialog" 
      :show="showProfileDialog"
      @profile-saved="handleProfileSaved"
      @cancel="handleProfileCancel"
    />
    
    <!-- Main Application -->
    <div v-else-if="isAuthenticated && !showProfileDialog" class="container mx-auto px-4 py-8">
      <header class="mb-8">
        <div class="flex justify-between items-center">
          <div>
            <h1 class="text-3xl font-bold text-gray-900 mb-2">CREATESPACE</h1>
            <p class="text-gray-600">Quote Generation System</p>
          </div>
          <div class="flex items-center space-x-4">
            <span class="text-sm text-gray-600">
              Welcome, {{ currentUser?.firstName || currentUser?.id || 'User' }}
            </span>
            <button
              @click="handleLogout"
              class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
            >
              Logout
            </button>
          </div>
        </div>
      </header>
      

      
      <!-- Customer Assignment Check -->
      <div v-if="!hasCustomerId" class="card text-center py-12">
        <div class="text-yellow-600 text-lg font-medium mb-2">No Customer Assigned</div>
        <p class="text-gray-600 mb-4">No customer has been assigned to you yet. Please contact your administrator.</p>
      </div>
      
      <!-- Main Application Content -->
      <PriceListManager 
        v-else-if="hasCustomerId" 
        :customer-id="customerId" 
        :key="`price-list-manager-${customerId}`"
      />
    </div>
  </div>
</template>

<script>
import PriceListManager from './components/PriceListManager.vue'
import LoginForm from './components/LoginForm.vue'
import UserProfileDialog from './components/UserProfileDialog.vue'
import { authService } from './services/authService.js'

export default {
  name: 'App',
  components: {
    PriceListManager,
    LoginForm,
    UserProfileDialog
  },
  data() {
    return {
      isAuthenticated: false,
      currentUser: null,
      showProfileDialog: false,
      loginData: null,
      customerId: null
    }
  },
  computed: {
    hasCustomerId() {
      return !!this.customerId
    }
  },
  async mounted() {
    // Check authentication status
    this.isAuthenticated = authService.isAuthenticated()
    
    if (this.isAuthenticated) {
      // Always refetch user data on page refresh to ensure we have the latest information
      try {
        this.currentUser = await authService.getCurrentUser()
        this.customerId = authService.getCustomerId(this.currentUser)
        console.log('User data refreshed on page load:', this.currentUser)
        console.log('Customer ID refreshed on page load:', this.customerId)
      } catch (error) {
        console.error('Failed to refresh user data on page load:', error)
        // If we can't get fresh user data, try to use cached data
        this.currentUser = await authService.getCurrentUserCached()
        this.customerId = authService.getCustomerId(this.currentUser)
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
        // Existing user, get their profile
        this.currentUser = await authService.getCurrentUser()
        this.customerId = authService.getCustomerId(this.currentUser)
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
    }
  }
}
</script>
