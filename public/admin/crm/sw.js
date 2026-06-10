self.addEventListener('push', function(e){
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch(err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'ProfesorMVT CRM', {
    body: d.body || '', icon: '/admin/crm/icon-192.png', badge: '/admin/crm/icon-192.png',
    data: { url: (d.url || '/admin/crm/') }
  }));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(clients.openWindow((e.notification.data && e.notification.data.url) || '/admin/crm/'));
});
