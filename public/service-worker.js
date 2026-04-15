const scopePath = new URL(self.registration.scope).pathname

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (event.request.method === 'POST' && url.pathname === `${scopePath}share-target/`) {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData()
        const params = new URLSearchParams({
          share: '1',
          title: `${formData.get('title') ?? ''}`,
          text: `${formData.get('text') ?? ''}`,
          url: `${formData.get('url') ?? ''}`,
        })

        return Response.redirect(`${scopePath}?${params.toString()}`, 303)
      })(),
    )
  }
})
