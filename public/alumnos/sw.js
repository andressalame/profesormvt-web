/* Service worker del portal del alumno · Web Push */
self.addEventListener('push', function(e){
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch(err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'ProfesorMVT', {
    body: d.body || '',
    icon: '/apple-touch-icon.png',
    badge: '/favicon-32.png',
    data: { url: (d.url || '/alumnos/') }
  }));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || '/alumnos/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(wins){
      for (var i = 0; i < wins.length; i++){
        if (wins[i].url.indexOf('/alumnos/') >= 0 && 'focus' in wins[i]){
          wins[i].focus();
          if ('navigate' in wins[i]) { try { wins[i].navigate(target); } catch(err){} }
          return;
        }
      }
      return clients.openWindow(target);
    })
  );
});
