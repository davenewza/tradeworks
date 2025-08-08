<template>
  <div v-if="show" class="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
    <div class="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
      <div class="mt-3">
        <div class="flex items-center justify-center w-12 h-12 mx-auto bg-green-100 rounded-full">
          <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>
          </svg>
        </div>
        
        <h3 class="text-lg font-medium text-gray-900 text-center mt-4 mb-4">
          Complete Your Profile
        </h3>
        
        <p class="text-sm text-gray-600 text-center mb-6">
          Please provide your first and last name to complete your account setup.
        </p>
        
        <form @submit.prevent="handleSubmit">
          <div class="space-y-4">
            <div>
              <label for="firstName" class="block text-sm font-medium text-gray-700 mb-1">
                First Name *
              </label>
              <input
                id="firstName"
                v-model="firstName"
                type="text"
                required
                class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="Enter your first name"
              />
            </div>
            
            <div>
              <label for="lastName" class="block text-sm font-medium text-gray-700 mb-1">
                Last Name *
              </label>
              <input
                id="lastName"
                v-model="lastName"
                type="text"
                required
                class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="Enter your last name"
              />
            </div>
            
            <div v-if="error" class="text-sm text-red-600">
              {{ error }}
            </div>
          </div>
          
          <div class="flex justify-end space-x-3 mt-6">
            <button
              type="button"
              @click="handleCancel"
              class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              :disabled="loading || !isValid"
              class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ loading ? 'Saving...' : 'Save Profile' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'UserProfileDialog',
  props: {
    show: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      firstName: '',
      lastName: '',
      loading: false,
      error: ''
    }
  },
  computed: {
    isValid() {
      return this.firstName.trim() && this.lastName.trim()
    }
  },
  methods: {
    async handleSubmit() {
      if (!this.isValid) {
        this.error = 'Please enter both first and last name.'
        return
      }

      this.loading = true
      this.error = ''
      
      try {
        this.$emit('profile-saved', {
          firstName: this.firstName.trim(),
          lastName: this.lastName.trim()
        })
      } catch (error) {
        this.error = error.message || 'Failed to save profile. Please try again.'
      } finally {
        this.loading = false
      }
    },
    
    handleCancel() {
      this.$emit('cancel')
    }
  }
}
</script>
