const { app } = require('electron');
console.log('SMOKE_OK electron=' + process.versions.electron + ' chrome=' + process.versions.chrome);
app.whenReady().then(() => {
  console.log('SMOKE_READY');
  app.exit(0);
});
setTimeout(() => {
  console.log('SMOKE_TIMEOUT');
  app.exit(3);
}, 20000);
