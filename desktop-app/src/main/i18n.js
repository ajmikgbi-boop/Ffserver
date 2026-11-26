'use strict';

/**
 * Arabic strings and formatting helpers for the main process (tray, dialogs,
 * notifications, sync notices and error messages).
 *
 * Technical text (paths, URLs, codes) embedded in Arabic sentences is wrapped in
 * Unicode directional isolates so slashes and dots never render backwards, both in
 * the app window and in OS-rendered text such as notifications.
 */

// Arabic with Western digits: keeps sizes, versions, dates and paths consistent.
// Use 'ar' instead to switch every number to Arabic-Indic digits.
const LOCALE = 'ar-u-nu-latn';

const LRI = '\u2066'; // left-to-right isolate
const FSI = '\u2068'; // first-strong isolate (direction from content)
const PDI = '\u2069'; // pop directional isolate

/** Isolate left-to-right technical text: URLs, codes, status numbers. */
const ltr = (text) => `${LRI}${text}${PDI}`;
/** Isolate user-provided text whose direction is unknown (device and file names). */
const iso = (text) => `${FSI}${text}${PDI}`;
/**
 * A path as a left-to-right run whose segments are each isolated with their own
 * direction: separators keep their order and Arabic names keep their extension
 * attached ("تقارير/الميزانية 2027.xlsx" never turns into "xlsx.الميزانية…").
 */
const path = (text) =>
  ltr(
    String(text)
      .split(/([\\/])/)
      .map((part) => (part === '/' || part === '\\' || !part ? part : iso(part)))
      .join(''),
  );
/** Quote with Arabic guillemets. */
const q = (isolated) => `«${isolated}»`;

const pluralRules = new Intl.PluralRules('ar');
const numberFormat = new Intl.NumberFormat(LOCALE);

/** Pick the correct Arabic plural form (zero/one/two/few/many/other) and insert {n}. */
function plural(n, forms) {
  const form = forms[pluralRules.select(n)] || forms.other;
  return form.replace('{n}', numberFormat.format(n));
}

// Noun forms after a verbal noun (genitive), e.g. "جاري مزامنة عنصرين".
const ITEMS_GEN = { one: 'عنصر واحد', two: 'عنصرين', few: '{n} عناصر', many: '{n} عنصرًا', other: '{n} عنصر' };
const FILES_GEN = { one: 'ملف واحد', two: 'ملفين', few: '{n} ملفات', many: '{n} ملفًا', other: '{n} ملف' };

const PLATFORM_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

const SERVER_ERRORS = {
  INVALID_SERVER_CODE:
    'رمز الخادم غير صالح. يجب أن يتكوّن من 3 إلى 64 حرفًا من الأحرف الإنجليزية أو الأرقام أو "-" أو "_"، وأن يبدأ بحرف أو رقم.',
  CODE_NOT_ALLOWED: 'رمز الخادم هذا غير مسموح به على هذا الخادم.',
  INVALID_DEVICE: 'معرّف الجهاز غير صالح.',
  INVALID_DEVICE_NAME: 'يجب أن يتكوّن اسم الجهاز من 1 إلى 64 حرفًا.',
  NOT_FOUND: 'الملف غير موجود في مساحة العمل.',
  CONFLICT: 'تم تعديل الملف على جهاز آخر في الوقت نفسه.',
  SIZE_MISMATCH: 'حجم الملف المحفوظ في السحابة لا يطابق الملف المرفوع.',
  INVALID_PATH: 'اسم الملف أو مساره غير صالح.',
  INVALID_HASH: 'بصمة الملف (SHA-256) غير صالحة.',
  INVALID_SIZE: 'حجم الملف غير صالح.',
  INVALID_UPLOAD: 'بيانات الرفع غير صالحة.',
  DEVICE_ONLINE: 'لا يمكن إزالة إلا الأجهزة غير المتصلة.',
  INTERNAL: 'تعذّر على الخادم إتمام الطلب. يُرجى المحاولة مرة أخرى.',
  UNAVAILABLE: 'الخادم غير قادر على استقبال الاتصالات مؤقتًا.',
  OFFLINE: 'غير متصل بخادم المزامنة.',
  TIMEOUT: 'لم يستجب الخادم في الوقت المحدد.',
  ERROR: 'تعذّر إتمام الطلب.',
};

const SYSTEM_ERRORS = {
  EACCES: 'تم رفض الوصول إلى الملف أو المجلد.',
  EPERM: 'لا توجد صلاحية كافية للوصول إلى الملف أو المجلد.',
  EBUSY: 'الملف قيد الاستخدام من قِبل برنامج آخر.',
  ENOENT: 'الملف أو المجلد غير موجود.',
  ENOSPC: 'لا توجد مساحة كافية على القرص.',
  EEXIST: 'يوجد ملف بالاسم نفسه بالفعل.',
  EISDIR: 'يوجد مجلد بالاسم نفسه.',
  ENOTDIR: 'جزء من المسار ليس مجلدًا.',
  ENAMETOOLONG: 'اسم الملف أو مساره طويل جدًا.',
  EMFILE: 'يوجد عدد كبير جدًا من الملفات المفتوحة.',
  EROFS: 'القرص للقراءة فقط.',
  ECONNRESET: 'انقطع الاتصال بالشبكة.',
  ECONNREFUSED: 'رفض الخادم الاتصال.',
  ETIMEDOUT: 'انتهت مهلة الاتصال بالشبكة.',
  ENOTFOUND: 'تعذّر العثور على عنوان الخادم.',
  EAI_AGAIN: 'تعذّر الوصول إلى خادم أسماء النطاقات (DNS).',
  EPIPE: 'انقطع الاتصال في أثناء نقل البيانات.',
  ENETUNREACH: 'الشبكة غير متاحة.',
  EHOSTUNREACH: 'تعذّر الوصول إلى الخادم عبر الشبكة.',
};

const ARABIC_RE = /[؀-ۿ]/;

/** Arabic message for any error: our own (already Arabic), server error codes, or OS error codes. */
function translateError(err) {
  if (!err) return 'حدث خطأ غير معروف.';
  const message = typeof err === 'string' ? err : err.message || '';
  if (ARABIC_RE.test(message)) return message;
  if (err.code && SERVER_ERRORS[err.code]) return SERVER_ERRORS[err.code];
  if (err.code && SYSTEM_ERRORS[err.code]) return SYSTEM_ERRORS[err.code];
  const cause = err.cause && err.cause.code;
  if (cause && SYSTEM_ERRORS[cause]) return SYSTEM_ERRORS[cause];
  return message ? `حدث خطأ غير متوقع (${ltr(message)}).` : 'حدث خطأ غير متوقع.';
}

/** Arabic error carrying a code, so callers can still branch on err.code. */
function localizedError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

const S = {
  appName: 'CompanySync',

  status: {
    notConnected: 'غير متصل',
    refused: 'رُفض الاتصال',
    reconnecting: 'جاري إعادة الاتصال…',
    starting: 'جاري البدء…',
    upToDate: 'محدّث',
    scanning: 'جاري البحث عن تغييرات…',
    offline: 'غير متصل',
    syncing: (n) => `جاري مزامنة ${plural(n, ITEMS_GEN)}…`,
    failed: (n) => `تعذّرت مزامنة ${plural(n, ITEMS_GEN)}`,
  },

  tray: {
    open: 'فتح CompanySync',
    openFolder: 'فتح مجلد المزامنة',
    syncNow: 'مزامنة الآن',
    launchAtLogin: 'التشغيل عند تسجيل الدخول',
    quit: 'إنهاء CompanySync',
    tooltip: (status) => `CompanySync — ${status}`,
    keepsRunningTitle: 'لا يزال CompanySync يعمل',
    keepsRunningBody: 'يستمر التطبيق في المزامنة من علبة النظام. استخدم أيقونة العلبة لفتحه أو إنهائه.',
  },

  macMenu: {
    about: 'حول CompanySync',
    hide: 'إخفاء CompanySync',
    hideOthers: 'إخفاء الآخرين',
    showAll: 'إظهار الكل',
    quit: 'إنهاء CompanySync',
    edit: 'تحرير',
    undo: 'تراجع',
    redo: 'إعادة',
    cut: 'قص',
    copy: 'نسخ',
    paste: 'لصق',
    selectAll: 'تحديد الكل',
    view: 'عرض',
    reload: 'إعادة التحميل',
    devTools: 'أدوات المطوّر',
    fullscreen: 'ملء الشاشة',
    window: 'نافذة',
    minimize: 'تصغير',
    zoom: 'تكبير/تصغير',
    close: 'إغلاق',
  },

  connect: {
    contacting: 'جاري الاتصال بالخادم… (قد يستغرق تشغيل الخادم المجاني ما يصل إلى دقيقة)',
    opening: 'جاري فتح قناة المزامنة…',
    stillStarting: 'الخادم متاح، لكن قناة المزامنة ما زالت قيد التشغيل. سيواصل التطبيق المحاولة تلقائيًا.',
    nameRequired: 'أدخل اسمًا لهذا الجهاز.',
    timeout: (url) =>
      `لم يستجب الخادم ${ltr(url)}. قد يستغرق تشغيل الخوادم المجانية ما يصل إلى دقيقة، يُرجى المحاولة مرة أخرى.`,
    notFound: (url) => `تعذّر العثور على العنوان ${ltr(url)}. تحقّق من عنوان الخادم.`,
    refused: (url) => `لا توجد خدمة تعمل على العنوان ${ltr(url)}. تحقّق من عنوان الخادم.`,
    tls: (url, code) => `فشل الاتصال الآمن بالخادم ${ltr(url)} (${ltr(code)}). تحقّق من إعدادات شهادة SSL للنطاق.`,
    unreachable: (url, reason) => `تعذّر الوصول إلى ${ltr(url)}: ${reason}`,
    badStatus: (url, status) => `ردّ الخادم ${ltr(url)} برمز HTTP ${ltr(String(status))}. هل هذا خادم CompanySync؟`,
    serverUrlRequired: 'أدخل عنوان الخادم.',
    serverUrlInvalid: 'عنوان الخادم غير صالح.',
    serverUrlScheme: `يجب أن يبدأ عنوان الخادم بـ ${ltr('https://')}`,
    connectFailed: 'تعذّر الاتصال بالخادم.',
    serverClosed: 'قطع الخادم الاتصال.',
    timedOut: 'انتهت مهلة الاتصال.',
  },

  dialogs: {
    cancel: 'إلغاء',
    disconnectTitle: 'قطع الاتصال بهذا الخادم؟',
    disconnectDetail: 'ستتوقف المزامنة حتى تتصل مرة أخرى. تبقى الملفات الموجودة في مجلد المزامنة على هذا الجهاز.',
    disconnectConfirm: 'قطع الاتصال',
    removeDeviceTitle: (name) => `إزالة ${q(iso(name || 'هذا الجهاز'))} من قائمة الأجهزة؟`,
    removeDeviceDetail: 'سيظهر الجهاز في القائمة مرة أخرى تلقائيًا إذا اتصل من جديد.',
    removeDeviceConfirm: 'إزالة',
    chooseFolder: 'اختر المجلد المراد مزامنته',
    chooseNewFolder: 'اختر مجلدًا جديدًا للمزامنة',
    changeFolderTitle: (folder) => `مزامنة المجلد ${q(path(folder))} بدلًا من المجلد الحالي؟`,
    changeFolderDetail:
      'سيتم تنزيل جميع ملفات مساحة العمل إلى المجلد الجديد ورفع الملفات الموجودة فيه مسبقًا. لن يتغيّر شيء في المجلد القديم.',
    changeFolderConfirm: 'تغيير المجلد',
    saveCopy: 'حفظ نسخة',
    uploadFiles: 'رفع ملفات',
    deleteFileTitle: (name) => `حذف ${q(iso(name))}؟`,
    deleteFolderTitle: (folder, count) => `حذف المجلد ${q(path(folder))} و${plural(count, FILES_GEN)} بداخله؟`,
    deleteDetail: 'سيُحذف من السحابة ومن جميع الأجهزة المتصلة، وتُنقل النسخ المحلية إلى سلة المحذوفات.',
    deleteConfirm: 'حذف',
    startupFailed: (detail) => `تعذّر تشغيل التطبيق:\n${detail}`,
  },

  errors: {
    notConnected: 'غير متصل بأي خادم.',
    renameEmpty: 'لا يمكن أن يكون اسم الجهاز فارغًا.',
    driveRoot: 'اختر مجلدًا، وليس جذر محرك أقراص.',
    internalFolder: 'هذا المجلد مستخدم داخليًا من قِبل التطبيق.',
    notDownloaded: 'لم يتم تنزيل هذا الملف إلى هذا الجهاز بعد.',
    nothingToUpload: 'لا يوجد ما يمكن رفعه.',
    autoConnectFailed: (reason) => `تعذّر بدء المزامنة: ${reason}`,
  },

  sync: {
    rootIsFile: (root) => `مسار مجلد المزامنة يشير إلى ملف وليس مجلدًا: ${path(root)}`,
    outsideRoot: (rel) => `تم رفض الوصول إلى مسار خارج مجلد المزامنة: ${path(rel)}`,
    cloudEmpty:
      'مساحة العمل السحابية فارغة رغم أن هذا المجلد تمت مزامنته سابقًا. حرصًا على سلامة بياناتك لن يُحذف أي ملف محلي، وستُرفع ملفاتك مرة أخرى.',
    folderEmpty:
      'مجلد المزامنة فارغ رغم أنه تمت مزامنته سابقًا. حرصًا على سلامة بياناتك لن يُحذف أي ملف من السحابة، وستُنزَّل الملفات مرة أخرى.',
    listFailed: (reason) => `تعذّرت قراءة قائمة الملفات السحابية: ${reason}`,
    cannotSync: (rel, reason) => `لا يمكن مزامنة ${q(path(rel))}: ${reason}`,
    couldNotSync: (rel, reason) => `تعذّرت مزامنة ${q(path(rel))}: ${reason}`,
    caseClash: (rel, other) =>
      `يختلف ${q(path(rel))} عن ${q(path(other))} في حالة الأحرف فقط، ولا يمكن حفظهما معًا على هذا الجهاز.`,
    notPortable: (rel) => `يحتوي ${q(path(rel))} على أحرف غير مسموح بها في أسماء الملفات على هذا الجهاز.`,
    conflict: (rel, target) =>
      `تعارض: تم تعديل ${q(path(rel))} على هذا الجهاز وعلى جهاز آخر. حُفظت نسختك باسم ${q(path(target))}.`,
    cloudChanged: 'تغيّرت النسخة السحابية في أثناء العملية.',
    changedDuringUpload: 'تغيّر الملف في أثناء رفعه.',
    changedDuringDownload: 'تغيّر الملف المحلي في أثناء التنزيل.',
    deletedMeanwhile: 'حُذف الملف من السحابة في أثناء العملية.',
    stillWriting: 'لا تزال كتابة الملف جارية.',
    gaveUp: (reason) => `توقفت المحاولات بعد تغييرات متكررة: ${reason}`,
    noEtag: (part) => `لم يُرجع التخزين السحابي معرّف ETag للجزء ${part}.`,
    changedByOther: 'عدّل جهاز آخر هذا الملف للتو. يُرجى مراجعته ثم المحاولة مرة أخرى.',
    conflictCopyName: (stem, device, stamp, ext) => `${stem} (نسخة متعارضة من ${device} ${stamp})${ext}`,
    thisDevice: 'هذا الجهاز',
  },

  transfer: {
    timeout: 'انتهت مهلة الاتصال بالشبكة.',
    cancelled: 'تم إلغاء النقل.',
    storageStatus: (status, code) =>
      `ردّ التخزين السحابي برمز الحالة ${ltr(String(status))}${code ? ` (${ltr(code)})` : ''}.`,
    sizeMismatch: (got, expected) => `تم تنزيل ${got} بايت بدلًا من ${expected} بايت.`,
    hashMismatch: 'فشل التحقق من سلامة الملف الذي تم تنزيله (SHA-256).',
  },
};

module.exports = {
  LOCALE,
  ltr,
  iso,
  path,
  q,
  plural,
  translateError,
  localizedError,
  PLATFORM_NAMES,
  SERVER_ERRORS,
  S,
};
