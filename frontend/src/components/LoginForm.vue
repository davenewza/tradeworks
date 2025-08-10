<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 py-0 px-4 sm:px-6 lg:px-8 overflow-hidden">
    <div class="max-w-md w-full space-y-8">
      <div>
        <div class="flex justify-center mb-8">
          <img src="/createspace-logo.png" alt="CREATESPACE" class="h-10 w-auto" />
        </div>
        <h2 class="mt-4 text-center text-3xl font-extrabold text-gray-900">
          Sign in to your account
        </h2>
        <p class="mt-2 text-center text-sm text-gray-600">
          Enter your credentials to access the order management system
        </p>
      </div>
      
      <form class="mt-8 space-y-6" @submit.prevent="handleLogin">
        <div class="rounded-md shadow-sm -space-y-px">
          <div>
            <label for="email" class="sr-only">Email address</label>
            <input
              id="email"
              v-model="email"
              name="email"
              type="email"
              required
              class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
              placeholder="Email address"
            />
          </div>
          <div>
            <label for="password" class="sr-only">Password</label>
            <input
              id="password"
              v-model="password"
              name="password"
              type="password"
              required
              class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
              placeholder="Password"
            />
          </div>
        </div>

        <div v-if="error" class="rounded-md bg-red-50 p-4">
          <div class="flex">
            <div class="flex-shrink-0">
              <svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
              </svg>
            </div>
            <div class="ml-3">
              <h3 class="text-sm font-medium text-red-800">
                {{ error }}
              </h3>
            </div>
          </div>
        </div>

        <div>
          <button
            type="submit"
            :disabled="loading"
            class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span v-if="loading" class="absolute left-0 inset-y-0 flex items-center pl-3">
              <svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </span>
            {{ loading ? 'Signing in...' : 'Sign in' }}
          </button>
        </div>

        <div class="text-center">
          <button
            type="button"
            @click="showForgotPassword = true"
            class="text-sm text-indigo-600 hover:text-indigo-500"
          >
            Forgot your password?
          </button>
        </div>
      </form>

      <div class="relative my-6">
        <div class="absolute inset-0 flex items-center"><div class="w-full border-t border-gray-200"></div></div>
        <div class="relative flex justify-center text-sm"><span class="px-2 bg-gray-50 text-gray-500">Or</span></div>
      </div>
      <button @click="signInWithGoogle" type="button" class="w-full inline-flex items-center justify-center gap-2 border border-gray-300 rounded-md px-4 py-2 hover:bg-gray-100">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" class="w-5 h-5"><path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12    s5.373-12,12-12c3.059,0,5.842,1.153,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24    s8.955,20,20,20s20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/><path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,16.108,18.961,13,24,13c3.059,0,5.842,1.153,7.961,3.039l5.657-5.657    C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/><path fill="#4CAF50" d="M24,44c4.983,0,9.514-1.917,12.961-5.039l-5.981-5.064C29.047,35.091,26.715,36,24,36    c-5.202,0-9.619-3.317-11.277-7.951l-6.534,5.036C9.582,39.556,16.227,44,24,44z"/><path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.103,5.597c0,0,0,0,0,0l6.581,5.561    c-0.465,0.427,7.219-5.289,7.219-15.238C44,22.659,43.862,21.35,43.611,20.083z"/></svg>
        <span>Continue with Google</span>
      </button>
    </div>

    <!-- Forgot Password Modal -->
    <div v-if="showForgotPassword" class="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div class="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
        <div class="mt-3">
          <h3 class="text-lg font-medium text-gray-900 mb-4">Reset Password</h3>
          <form @submit.prevent="handleForgotPassword">
            <div class="mb-4">
              <label for="reset-email" class="block text-sm font-medium text-gray-700 mb-2">
                Email address
              </label>
              <input
                id="reset-email"
                v-model="resetEmail"
                type="email"
                required
                class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="Enter your email"
              />
            </div>
            
            <div v-if="resetError" class="mb-4 text-sm text-red-600">
              {{ resetError }}
            </div>
            
            <div v-if="resetSuccess" class="mb-4 text-sm text-green-600">
              {{ resetSuccess }}
            </div>

            <div class="flex justify-end space-x-3">
              <button
                type="button"
                @click="showForgotPassword = false"
                class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                :disabled="resetLoading"
                class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                {{ resetLoading ? 'Sending...' : 'Send Reset Link' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { authService } from '../services/authService.js'

export default {
  name: 'LoginForm',
  data() {
    return {
      email: '',
      password: '',
      loading: false,
      error: '',
      showForgotPassword: false,
      resetEmail: '',
      resetLoading: false,
      resetError: '',
      resetSuccess: ''
    }
  },
  methods: {
    async handleLogin() {
      this.loading = true
      this.error = ''
      
      try {
        const loginData = await authService.login(this.email, this.password)
        this.$emit('login-success', loginData)
      } catch (error) {
        this.error = error.message || 'Login failed. Please check your credentials.'
      } finally {
        this.loading = false
      }
    },
    
    async handleForgotPassword() {
      this.resetLoading = true
      this.resetError = ''
      this.resetSuccess = ''
      
      try {
        const redirectUrl = `${window.location.origin}/reset-password`
        await authService.requestPasswordReset(this.resetEmail, redirectUrl)
        this.resetSuccess = 'Password reset link has been sent to your email.'
        this.resetEmail = ''
      } catch (error) {
        this.resetError = error.message || 'Failed to send reset link. Please try again.'
      } finally {
        this.resetLoading = false
      }
    },
    async signInWithGoogle() {
      try {
        const providers = await authService.getAuthProviders()
        const google = (providers || []).find(p => (p.name || '').toLowerCase().includes('google') || (p.type || '').toLowerCase().includes('google'))
        const target = google?.authorizeUrl || `${authService.baseUrl.replace('/api/json','')}/auth/authorize/google`
        window.location.href = target
      } catch (e) {
        this.error = e.message || 'Google sign-in not available'
      }
    }
  }
}
</script>
