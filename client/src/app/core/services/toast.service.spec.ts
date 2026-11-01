import { Subject } from 'rxjs';
import { ToastService } from './toast.service';

describe('ToastService.working', () => {
  it('shows the message while the request is on its way, and takes it down when it ends', () => {
    const toast = new ToastService();
    const request = new Subject<string>();
    const sub = request.pipe(toast.working('刪除中…')).subscribe();
    expect(toast.toasts().map((t) => [t.kind, t.message])).toEqual([['info', '刪除中…']]);

    request.next('done');
    request.complete();
    expect(toast.toasts()).toEqual([]);
    sub.unsubscribe();
  });

  it('takes it down when the request fails too, and shows nothing before it is subscribed', () => {
    const toast = new ToastService();
    const request = new Subject<string>();
    const piped = request.pipe(toast.working('刪除中…'));
    expect(toast.toasts()).toEqual([]);
    piped.subscribe({ error: () => undefined });
    request.error(new Error('offline'));
    expect(toast.toasts()).toEqual([]);
  });
});
