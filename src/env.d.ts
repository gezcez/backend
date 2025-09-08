// env.d.ts
declare global {
   namespace NodeJS {
      interface ProcessEnv {
         NODE_ENV: 'dev' | 'production'
         PORT?: number
         HOST?: string
         JWT_RANDOM_STUFF: string
         KEY_EMAIL_SERVICE: string
         AWS_ACCESS_KEY_ID: string
         AWS_SECRET_ACCESS_KEY: string
         AWS_REGION: string
         JWT_SECRET: string
         URL_DB: string
      }
   }
}

export {}