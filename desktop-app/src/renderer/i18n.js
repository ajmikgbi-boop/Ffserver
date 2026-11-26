'use strict';

/* Arabic strings and formatting for the renderer. Loaded before app.js; exposes window.L10N. */

(function () {
  // Arabic with Western digits (consistent with sizes, versions, paths and server codes).
  // Use 'ar' instead to switch every number to Arabic-Indic digits.
  const LOCALE = 'ar-u-nu-latn';

  const pluralRules = new Intl.PluralRules('ar');
  const integer = new Intl.NumberFormat(LOCALE);
  const decimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
  const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
  const dateOnly = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });

  /** Pick the Arabic plural form (zero/one/two/few/many/other) and insert {n}. */
  function plural(n, forms) {
    const form = forms[pluralRules.select(n)] || forms.other;
    return form.replace('{n}', integer.format(n));
  }

  /** Path as an LTR run of individually isolated segments (for plain-text contexts such as toasts). */
  function isoPath(text) {
    const parts = String(text)
      .split(/([\\/])/)
      .map((part) => (part === '/' || part === '\\' || !part ? part : `\u2068${part}\u2069`));
    return `\u2066${parts.join('')}\u2069`;
  }

  const UNITS = ['بايت', 'ك.ب', 'م.ب', 'غ.ب', 'ت.ب'];

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
      value /= 1024;
      unit++;
    }
    const shown = unit === 0 ? integer.format(value) : value >= 100 ? integer.format(Math.round(value)) : decimal.format(value);
    return `${shown} ${UNITS[unit]}`;
  }

  function formatRelative(ts) {
    if (!ts) return 'أبدًا';
    const seconds = Math.round((Date.now() - ts) / 1000);
    if (seconds < 45) return 'الآن';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return relative.format(-minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (hours < 24) return relative.format(-hours, 'hour');
    const days = Math.round(hours / 24);
    if (days < 7) return relative.format(-days, 'day');
    return dateOnly.format(new Date(ts));
  }

  function formatDateTime(ts) {
    return ts ? dateTime.format(new Date(ts)) : '';
  }

  // Noun forms. NOM = after a number on its own ("ملفان"), GEN = after a verbal noun ("رفع ملفين").
  const FILES_NOM = { zero: 'لا توجد ملفات', one: 'ملف واحد', two: 'ملفان', few: '{n} ملفات', many: '{n} ملفًا', other: '{n} ملف' };
  const FILES_GEN = { one: 'ملف واحد', two: 'ملفين', few: '{n} ملفات', many: '{n} ملفًا', other: '{n} ملف' };
  const ITEMS_GEN = { one: 'عنصر واحد', two: 'عنصرين', few: '{n} عناصر', many: '{n} عنصرًا', other: '{n} عنصر' };

  const T = {
    connect: 'اتصال',
    connecting: 'جاري الاتصال…',
    contactingServer: 'جاري الاتصال بالخادم…',
    urlRequired: 'أدخل عنوان الخادم، مثل \u2066https://sync.yourcompany.com\u2069',
    codeRequired: 'أدخل رمز الخادم الخاص بمساحة العمل.',
    nameRequired: 'أدخل اسمًا لهذا الجهاز، مثل «حاسوب المكتب الرئيسي».',

    conn: {
      connected: 'متصل',
      connectingTo: 'جاري الاتصال بـ',
      reconnecting: 'جاري إعادة الاتصال…',
      reconnectingAttempt: (n) => `جاري إعادة الاتصال… (المحاولة ${integer.format(n)})`,
      refused: 'رُفض الاتصال',
      idle: 'غير متصل',
      chipTitle: 'رمز الخادم',
    },

    theme: {
      names: { system: 'حسب النظام', light: 'فاتح', dark: 'داكن' },
      title: (name) => `المظهر: ${name} (انقر للتغيير)`,
    },

    sync: {
      starting: 'جاري البدء…',
      upToDate: 'محدّث',
      lastSynced: (when) => `آخر مزامنة: ${when}`,
      scanning: 'جاري البحث عن تغييرات…',
      syncing: (n) => `جاري مزامنة ${plural(n, ITEMS_GEN)}…`,
      offline: 'غير متصل',
      offlineSub: 'ستتم مزامنة التغييرات تلقائيًا عند توفر الاتصال بالخادم.',
      failed: (n) => `تعذّرت مزامنة ${plural(n, ITEMS_GEN)}`,
      retrying: 'ستتم إعادة المحاولة تلقائيًا.',
      skipped: (n) => `تم تخطي ${plural(n, ITEMS_GEN)} — راجع سجل النشاط`,
    },

    devices: {
      count: (online, total) => `${integer.format(online)} من ${integer.format(total)} متصل`,
      none: 'لا توجد أجهزة بعد.',
      afterConnect: 'تظهر قائمة الأجهزة بعد الاتصال.',
      online: 'متصل',
      offline: 'غير متصل',
      thisDevice: 'هذا الجهاز',
      lastSync: (when) => `آخر مزامنة: ${when}`,
      neverSynced: 'لم تتم المزامنة بعد',
      seen: (when) => `آخر ظهور: ${when}`,
      tooltipLastSync: (when) => `آخر مزامنة: ${when || 'أبدًا'}`,
      remove: 'إزالة من القائمة',
      renamed: 'تمت إعادة تسمية الجهاز.',
      renamedOffline: 'تمت إعادة التسمية. سيظهر الاسم الجديد للأجهزة الأخرى عند عودة الاتصال.',
      unknown: 'جهاز غير معروف',
      cloudStorage: 'التخزين السحابي',
    },

    status: {
      synced: 'متزامن',
      pending: 'قيد الانتظار',
      uploading: 'جاري الرفع',
      downloading: 'جاري التنزيل',
      syncing: 'جاري المزامنة',
      error: 'خطأ',
      skipped: 'تم التخطي',
    },

    files: {
      allFiles: 'جميع الملفات',
      search: (q) => `بحث: «${q}»`,
      folderCount: (n) => plural(n, FILES_NOM),
      summary: (n, size) => `${plural(n, FILES_NOM)} · ${size} في مساحة العمل`,
      showingFirst: (n) => ` · يتم عرض أول ${integer.format(n)} نتيجة`,
      open: 'فتح',
      openFolder: 'فتح المجلد',
      showInFolder: 'إظهار في المجلد',
      saveCopy: 'حفظ نسخة…',
      delete: 'حذف من السحابة',
      deleteFolder: 'حذف المجلد من السحابة',
      deletedFiles: (n) => `تم حذف ${plural(n, FILES_GEN)}.`,
      deletedFile: 'تم حذف الملف.',
      savedTo: (path) => `تم حفظ النسخة في «${isoPath(path)}».`,
      uploading: (n) => `جاري رفع ${plural(n, FILES_GEN)}…`,
      emptyTitle: 'لا توجد ملفات بعد',
      emptySub: 'أفلِت الملفات هنا، أو انقر على «رفع ملفات»، أو أضف ملفات إلى مجلد المزامنة.',
      noMatchTitle: 'لا توجد ملفات مطابقة',
      noMatchSub: 'جرّب كلمة بحث أخرى.',
      emptyFolderTitle: 'هذا المجلد فارغ',
      emptyFolderSub: 'أفلِت الملفات هنا لرفعها إلى هذا المجلد.',
      waitingTitle: 'في انتظار الخادم',
      waitingSub: 'ستظهر قائمة الملفات فور إنشاء الاتصال.',
    },

    drop: {
      into: (folder) => `إلى المجلد «${isoPath(folder)}» — تُنسخ الملفات إلى مجلد المزامنة ثم تُرفع`,
      intoRoot: 'إلى المجلد الرئيسي لمساحة العمل — تُنسخ الملفات إلى مجلد المزامنة ثم تُرفع',
      nothing: 'لا يوجد ما يمكن رفعه: يمكن إفلات الملفات والمجلدات الموجودة على جهازك فقط.',
    },

    activity: {
      added: ['قام ', '{who}', ' برفع الملف ', '{file}'],
      updated: ['قام ', '{who}', ' بتحديث الملف ', '{file}'],
      deleted: ['قام ', '{who}', ' بحذف الملف ', '{file}'],
      'device-online': ['أصبح ', '{who}', ' متصلًا'],
      'device-offline': ['أصبح ', '{who}', ' غير متصل'],
      'device-renamed': ['تمت إعادة تسمية ', '{old}', ' إلى ', '{who}'],
      'device-removed': ['تمت إزالة ', '{who}', ' من قائمة الأجهزة'],
      bulk: (n) => (n ? `رُصدت تغييرات أخرى في التخزين السحابي (${integer.format(n)})` : 'رُصدت تغييرات أخرى في التخزين السحابي'),
      fromThisDevice: 'هذا الجهاز',
      someDevice: 'جهاز',
    },

    dismiss: 'إغلاق',
  };

  window.L10N = Object.freeze({ LOCALE, plural, isoPath, formatBytes, formatRelative, formatDateTime, T });
})();
