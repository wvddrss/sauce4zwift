(async () => {
    try {
        // packed
        await import('../../app/src/main.mjs');
    } catch(e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') {
            await import('./main.mjs');  // dev
        } else {
            throw e;
        }
    }
})();
