import { superuserGuard } from './features/admin/superuser.guard';
import { Routes } from '@angular/router';
import { authGuard, accountIndexGuard, guestGuard } from './core/auth.guard';
import { adminGuard } from './features/admin/admin.guard';
import { regionGuard, rootRedirectGuard } from './core/region.guard';
import { unsavedChangesGuard } from './core/unsaved-changes.guard';

// `data: { preload: true }` marks the pages fetched in idle time after the
// first one loads (core/idle-preloading.strategy.ts): the ones a visitor
// usually opens next. The admin console is left out on purpose.
const featureRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
  },
  {
    path: 'search',
    data: { seo: { titleKey: 'nav.search' }, preload: true },
    loadComponent: () => import('./features/search/search').then((m) => m.Search),
  },
  {
    path: 'book',
    data: { preload: true },
    loadComponent: () => import('./features/book/book').then((m) => m.Book),
  },
  {
    path: 'sell',
    data: { seo: { titleKey: 'nav.sell' }, preload: true },
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./features/sell/sell').then((m) => m.Sell),
  },
  {
    path: 'login',
    data: { seo: { titleKey: 'auth.login' }, preload: true },
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login').then((m) => m.LoginPage),
  },
  {
    path: 'register',
    data: { seo: { titleKey: 'auth.registerTitle' }, preload: true },
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/register').then((m) => m.RegisterPage),
  },
  {
    path: 'account',
    data: { seo: { titleKey: 'nav.account' }, preload: true },
    // Guarded at the parent now that /account is the dashboard only — the
    // login wall it used to render on the same URL moved to /login.
    canActivate: [authGuard],
    loadComponent: () => import('./features/account/account').then((m) => m.Account),
    children: [
      { path: '', canActivate: [accountIndexGuard], data: { preload: true }, loadComponent: () => import('./features/account/account-index.component').then(m => m.AccountIndexComponent) },
      { path: 'listings', canActivate: [authGuard], data: { seo: { titleKey: 'acct.tabListings' }, preload: true }, loadComponent: () => import('./features/account/listings').then(m => m.ListingsComponent) },
      { path: 'subscriptions', canActivate: [authGuard], data: { seo: { titleKey: 'acct.tabSubs' } }, loadComponent: () => import('./features/account/subscriptions').then(m => m.SubscriptionsComponent) },
      { path: 'orders', canActivate: [authGuard], data: { seo: { titleKey: 'acct.myOrders' } }, loadComponent: () => import('./features/account/orders').then(m => m.OrdersComponent) },
      { path: 'reports', canActivate: [authGuard], data: { seo: { titleKey: 'acct.tabReports' } }, loadComponent: () => import('./features/account/reports').then(m => m.ReportsComponent) },
      { path: 'notifications', canActivate: [authGuard], data: { seo: { titleKey: 'acct.tabNotifications' } }, loadComponent: () => import('./features/account/notifications').then(m => m.NotificationsComponent) },
      { path: 'settings', canActivate: [authGuard], data: { seo: { titleKey: 'acct.tabSettings' }, preload: true }, loadComponent: () => import('./features/account/settings').then(m => m.SettingsComponent) }
    ]
  },
  // hidePrefs: no language/region pickers at the bottom of the checkout
  // flow; switching region mid-order would only strand it.
  { path: 'checkout/success', data: { seo: { titleKey: 'checkout.successTitle' }, hidePrefs: true }, loadComponent: () => import('./features/checkout/success').then(m => m.OrderSuccessComponent) },
  // Guarded, though it never used to be: placing an order needs a session.
  // Its entrances already assume one — listing-detail's canStartTransaction and
  // book's buy buttons bounce a signed-out visitor to /login themselves, and
  // messages' goToCheckout sits behind /messages' own authGuard. Saying so on
  // the route means a session that dies *while* the visitor is on checkout gets
  // the same answer, instead of leaving them on a page whose only button fails.
  // actionBar: the page pins its primary actions to the bottom on phones
  // (ui-action-bar), so the layout drops the tab bar there.
  { path: 'checkout/:id', data: { seo: { titleKey: 'checkout.title' }, actionBar: true, hidePrefs: true }, canActivate: [authGuard], loadComponent: () => import('./features/checkout/checkout').then(m => m.CheckoutComponent) },
  { path: 'listing/:id', data: { preload: true, actionBar: true }, loadComponent: () => import('./features/listing-detail/listing-detail').then(m => m.ListingDetail) },
  { path: 'seller/:id', data: { preload: true }, loadComponent: () => import('./features/seller/seller').then(m => m.SellerPageComponent) },
  {
    path: 'messages',
    data: { seo: { titleKey: 'nav.messages' }, preload: true },
    canActivate: [authGuard],
    loadComponent: () => import('./features/messages/messages').then((m) => m.Messages),
  },
  {
    path: 'verify',
    data: { seo: { titleKey: 'verify.title' } },
    loadComponent: () => import('./features/auth/verify').then((m) => m.VerifyEmail),
  },
  {
    path: 'forgot-password',
    data: { seo: { titleKey: 'auth.forgotPassword' } },
    loadComponent: () => import('./features/auth/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    path: 'admin',
    data: { seo: { titleKey: 'admin.title' } },
    canActivate: [adminGuard],
    loadComponent: () => import('./features/admin/admin-shell.component').then((m) => m.AdminShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'stats' },
      { path: 'stats', loadComponent: () => import('./features/admin/stats-dashboard.component').then(m => m.AdminStatsDashboardComponent) },
      { path: 'stats/books', loadComponent: () => import('./features/admin/stats-books.component').then(m => m.AdminStatsBooksComponent) },
      { path: 'stats/books/:id', loadComponent: () => import('./features/admin/book-stats.component').then(m => m.AdminBookStatsComponent), canDeactivate: [unsavedChangesGuard] },
      { path: 'stats/growth', loadComponent: () => import('./features/admin/stats-growth.component').then(m => m.AdminStatsGrowthComponent) },
      { path: 'stats/academics', loadComponent: () => import('./features/admin/stats-academics.component').then(m => m.AdminStatsAcademicsComponent) },
      { path: 'regions', canActivate: [superuserGuard], loadComponent: () => import('./features/admin/regions-list.component').then(m => m.AdminRegionsListComponent) },
      { path: 'regions/:id', canActivate: [superuserGuard], loadComponent: () => import('./features/admin/region-detail.component').then(m => m.AdminRegionDetailComponent) },
      { path: 'currencies', canActivate: [superuserGuard], loadComponent: () => import('./features/admin/currencies-list.component').then(m => m.AdminCurrenciesListComponent) },
      { path: 'currencies/:id', canActivate: [superuserGuard], loadComponent: () => import('./features/admin/currency-detail.component').then(m => m.AdminCurrencyDetailComponent) },
      { path: 'users', loadComponent: () => import('./features/admin/users-list.component').then(m => m.AdminUsersListComponent) },
      { path: 'users/:id', loadComponent: () => import('./features/admin/user-detail.component').then(m => m.AdminUserDetailComponent) },
      { path: 'schools', loadComponent: () => import('./features/admin/schools-list.component').then(m => m.AdminSchoolsListComponent) },
      { path: 'categories', loadComponent: () => import('./features/admin/categories-list.component').then(m => m.AdminCategoriesListComponent) },
      { path: 'schools/:id', loadComponent: () => import('./features/admin/school-detail.component').then(m => m.AdminSchoolDetailComponent) },
      { path: 'school-requests', loadComponent: () => import('./features/admin/school-requests-list.component').then(m => m.AdminSchoolRequestsListComponent) },
      { path: 'listings', loadComponent: () => import('./features/admin/listings-list.component').then(m => m.AdminListingsListComponent) },
      { path: 'listings/:id', loadComponent: () => import('./features/admin/listing-detail-admin.component').then(m => m.AdminListingDetailComponent) },
      { path: 'books', loadComponent: () => import('./features/admin/books-list.component').then(m => m.AdminBooksListComponent) },
      { path: 'books/:id', loadComponent: () => import('./features/admin/book-detail-admin.component').then(m => m.AdminBookDetailComponent), canDeactivate: [unsavedChangesGuard] },
      { path: 'orders', loadComponent: () => import('./features/admin/orders-list.component').then(m => m.AdminOrdersListComponent) },
      { path: 'orders/:id', loadComponent: () => import('./features/admin/order-detail-admin.component').then(m => m.AdminOrderDetailComponent) },
      { path: 'reports', loadComponent: () => import('./features/admin/reports-list.component').then(m => m.AdminReportsListComponent) },
      { path: 'chat-reports', loadComponent: () => import('./features/admin/chat-reports-list.component').then(m => m.AdminChatReportsListComponent) },
      { path: 'managers', loadComponent: () => import('./features/admin/managers-list.component').then(m => m.AdminManagersListComponent) },
      { path: 'advertisers', loadComponent: () => import('./features/admin/advertisers-list.component').then(m => m.AdminAdvertisersListComponent) },
      { path: 'promotions', loadComponent: () => import('./features/admin/ads-list.component').then(m => m.AdminAdsListComponent) },
    ]
  },
  {
    path: '**',
    // Cloudflare Pages serves the app shell with HTTP 200 for every path it
    // has no file for, so a mistyped or dead link is a "soft 404" a search
    // engine would index as a real page. The status cannot be changed without
    // running a Function on every navigation; noindex is the cheap signal.
    data: { seo: { titleKey: 'notfound.title', noindex: true } },
    loadComponent: () => import('./features/not-found/not-found').then(m => m.NotFoundComponent),
  }
];

export const routes: Routes = [
  {
    path: ':region',
    canActivate: [regionGuard],
    children: featureRoutes
  },
  {
    path: '**',
    canActivate: [rootRedirectGuard],
    children: []
  }
];
