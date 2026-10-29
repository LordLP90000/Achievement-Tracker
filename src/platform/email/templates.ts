import { ONE_TIME_TOKEN_LIFETIME_MS } from '../crypto/tokens.ts';
import type { Locale } from '../i18n/locales.ts';
import type { EmailTemplate } from './outbox-repository.ts';

/**
 * Email copy (A-19, S-11): fixed plain text in the user's language. Nothing a user typed and no goal content is ever
 * put into an email; the only variable part is the single-use link, built from the configured base URL. Notices carry
 * no link at all. Swiss locales use their language's text; German is written in Swiss orthography (no ß), which is
 * also correct elsewhere. The copy is to be reviewed by native speakers before launch (O-08).
 */

export const LINK_TEMPLATES = ['verify_email', 'password_reset', 'email_change_verify'] as const;
export type LinkTemplate = (typeof LINK_TEMPLATES)[number];
export type NoticeTemplate = Exclude<EmailTemplate, LinkTemplate>;
export const NOTICE_TEMPLATES: readonly NoticeTemplate[] = [
  'registration_notice',
  'password_changed_notice',
  'email_change_notice',
  'account_deleted_notice',
];

export type EmailContent =
  { readonly template: LinkTemplate; readonly link: string } | { readonly template: NoticeTemplate };

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
}

/** R-PRIV-06: the number stated in `account_deleted_notice`; a test keeps it equal to the enforced grace period. */
export const DELETION_GRACE_DAYS = 30;

const LINK_PATHS: Readonly<Record<LinkTemplate, string>> = {
  verify_email: 'verify-email',
  password_reset: 'reset-password',
  email_change_verify: 'confirm-email-change',
};

const LINKS: ReadonlySet<EmailTemplate> = new Set(LINK_TEMPLATES);

export function isLinkTemplate(template: EmailTemplate): template is LinkTemplate {
  return LINKS.has(template);
}

/** The app link for a single-use token. The token travels in the fragment, which browsers never send to a server. */
export function linkFor(baseUrl: string, template: LinkTemplate, token: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/${LINK_PATHS[template]}#token=${token}`;
}

type Language = 'en' | 'de' | 'fr' | 'it';

const LANGUAGES: Readonly<Record<Locale, Language>> = {
  'de-CH': 'de',
  'fr-CH': 'fr',
  'it-CH': 'it',
  en: 'en',
  de: 'de',
  fr: 'fr',
  it: 'it',
};

/** Text before and after the link line. */
interface LinkCopy {
  readonly subject: string;
  readonly before: string;
  readonly after: string;
}

interface NoticeCopy {
  readonly subject: string;
  readonly paragraphs: readonly string[];
}

interface LanguageCopy {
  readonly greeting: string;
  readonly links: Readonly<Record<LinkTemplate, LinkCopy>>;
  readonly notices: Readonly<Record<NoticeTemplate, NoticeCopy>>;
}

const SIGNATURE = 'Questline';
const NBSP = '\u00a0';

/** `{minutes}` is the link lifetime, `{days}` the deletion grace period. */
const COPY: Readonly<Record<Language, LanguageCopy>> = {
  en: {
    greeting: 'Hello,',
    links: {
      verify_email: {
        subject: 'Confirm your email address',
        before: 'Please confirm your email address for Questline by opening this link within {minutes} minutes:',
        after: 'If you did not create a Questline account, you can ignore this email.',
      },
      password_reset: {
        subject: 'Reset your password',
        before:
          'A new password was requested for your Questline account. Open this link within {minutes} minutes to ' +
          'choose it:',
        after: 'If you did not request this, you can ignore this email. Your password stays the same.',
      },
      email_change_verify: {
        subject: 'Confirm your new email address',
        before:
          'Please confirm that this address should be used for your Questline account by opening this link within ' +
          '{minutes} minutes:',
        after: 'If you did not request this, you can ignore this email.',
      },
    },
    notices: {
      registration_notice: {
        subject: 'Someone tried to use your email address',
        paragraphs: [
          'Someone tried to create a Questline account with this email address or to move an account to it. The ' +
            'address already belongs to a Questline account, so nothing was changed.',
          'If this was you, sign in with your existing account. If you forgot your password, reset it in the ' +
            'Questline app.',
          'If this was not you, you can ignore this email.',
        ],
      },
      password_changed_notice: {
        subject: 'Your password was changed',
        paragraphs: [
          'The password of your Questline account was just changed.',
          'If this was not you, reset your password in the Questline app right away. This signs out every device.',
        ],
      },
      email_change_notice: {
        subject: 'Your email address is being changed',
        paragraphs: [
          'A change of the email address of your Questline account to another address was requested. It takes ' +
            'effect once the new address is confirmed.',
          'If this was not you, change your password in the Questline app right away. This signs out every other ' +
            'device.',
        ],
      },
      account_deleted_notice: {
        subject: 'Your Questline account will be deleted',
        paragraphs: [
          'Your Questline account was deactivated and will be deleted for good in {days} days. If you sign in ' +
            'before then, it is reactivated.',
          'If this was not you, sign in right away and change your password.',
        ],
      },
    },
  },
  de: {
    greeting: 'Guten Tag',
    links: {
      verify_email: {
        subject: 'Bestätigen Sie Ihre E-Mail-Adresse',
        before:
          'Bitte bestätigen Sie Ihre E-Mail-Adresse für Questline, indem Sie innerhalb von {minutes} Minuten ' +
          'diesen Link öffnen:',
        after: 'Falls Sie kein Questline-Konto erstellt haben, können Sie diese E-Mail ignorieren.',
      },
      password_reset: {
        subject: 'Setzen Sie Ihr Passwort zurück',
        before:
          'Für Ihr Questline-Konto wurde ein neues Passwort angefordert. Öffnen Sie innerhalb von {minutes} Minuten ' +
          'diesen Link, um es festzulegen:',
        after:
          'Falls Sie das nicht angefordert haben, können Sie diese E-Mail ignorieren. Ihr Passwort bleibt ' +
          'unverändert.',
      },
      email_change_verify: {
        subject: 'Bestätigen Sie Ihre neue E-Mail-Adresse',
        before:
          'Bitte bestätigen Sie, dass diese Adresse für Ihr Questline-Konto verwendet werden soll, indem Sie ' +
          'innerhalb von {minutes} Minuten diesen Link öffnen:',
        after: 'Falls Sie das nicht angefordert haben, können Sie diese E-Mail ignorieren.',
      },
    },
    notices: {
      registration_notice: {
        subject: 'Jemand wollte Ihre E-Mail-Adresse verwenden',
        paragraphs: [
          'Jemand hat versucht, mit dieser E-Mail-Adresse ein Questline-Konto zu erstellen oder ein Konto auf diese ' +
            'Adresse umzustellen. Die Adresse gehört bereits zu einem Questline-Konto, deshalb wurde nichts geändert.',
          'Falls Sie das waren, melden Sie sich mit Ihrem bestehenden Konto an. Haben Sie Ihr Passwort vergessen, ' +
            'setzen Sie es in der Questline-App zurück.',
          'Falls Sie das nicht waren, können Sie diese E-Mail ignorieren.',
        ],
      },
      password_changed_notice: {
        subject: 'Ihr Passwort wurde geändert',
        paragraphs: [
          'Das Passwort Ihres Questline-Kontos wurde soeben geändert.',
          'Falls Sie das nicht waren, setzen Sie Ihr Passwort sofort in der Questline-App zurück. Dabei werden alle ' +
            'Geräte abgemeldet.',
        ],
      },
      email_change_notice: {
        subject: 'Ihre E-Mail-Adresse wird geändert',
        paragraphs: [
          'Für Ihr Questline-Konto wurde eine Änderung der E-Mail-Adresse auf eine andere Adresse angefordert. Sie ' +
            'wird wirksam, sobald die neue Adresse bestätigt ist.',
          'Falls Sie das nicht waren, ändern Sie sofort Ihr Passwort in der Questline-App. Dabei werden alle ' +
            'anderen Geräte abgemeldet.',
        ],
      },
      account_deleted_notice: {
        subject: 'Ihr Questline-Konto wird gelöscht',
        paragraphs: [
          'Ihr Questline-Konto wurde deaktiviert und wird in {days} Tagen endgültig gelöscht. Melden Sie sich ' +
            'vorher an, wird es wieder aktiviert.',
          'Falls Sie das nicht waren, melden Sie sich sofort an und ändern Sie Ihr Passwort.',
        ],
      },
    },
  },
  fr: {
    greeting: 'Bonjour,',
    links: {
      verify_email: {
        subject: 'Confirmez votre adresse e-mail',
        before: `Veuillez confirmer votre adresse e-mail pour Questline en ouvrant ce lien dans les {minutes} minutes${NBSP}:`,
        after: "Si vous n'avez pas créé de compte Questline, vous pouvez ignorer cet e-mail.",
      },
      password_reset: {
        subject: 'Réinitialisez votre mot de passe',
        before:
          'Un nouveau mot de passe a été demandé pour votre compte Questline. Ouvrez ce lien dans les {minutes} ' +
          `minutes pour le choisir${NBSP}:`,
        after:
          "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail. Votre mot de passe " +
          'reste inchangé.',
      },
      email_change_verify: {
        subject: 'Confirmez votre nouvelle adresse e-mail',
        before:
          'Veuillez confirmer que cette adresse doit être utilisée pour votre compte Questline en ouvrant ce lien ' +
          `dans les {minutes} minutes${NBSP}:`,
        after: "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.",
      },
    },
    notices: {
      registration_notice: {
        subject: "Quelqu'un a tenté d'utiliser votre adresse e-mail",
        paragraphs: [
          "Quelqu'un a tenté de créer un compte Questline avec cette adresse e-mail ou d'y transférer un compte. " +
            "Cette adresse appartient déjà à un compte Questline, rien n'a donc été modifié.",
          "Si c'était vous, connectez-vous avec votre compte existant. Si vous avez oublié votre mot de passe, " +
            "réinitialisez-le dans l'application Questline.",
          "Si ce n'était pas vous, vous pouvez ignorer cet e-mail.",
        ],
      },
      password_changed_notice: {
        subject: 'Votre mot de passe a été modifié',
        paragraphs: [
          "Le mot de passe de votre compte Questline vient d'être modifié.",
          "Si ce n'était pas vous, réinitialisez immédiatement votre mot de passe dans l'application Questline. " +
            'Tous les appareils seront alors déconnectés.',
        ],
      },
      email_change_notice: {
        subject: 'Votre adresse e-mail va être modifiée',
        paragraphs: [
          "Une modification de l'adresse e-mail de votre compte Questline vers une autre adresse a été demandée. " +
            'Elle prendra effet dès que la nouvelle adresse aura été confirmée.',
          "Si ce n'était pas vous, modifiez immédiatement votre mot de passe dans l'application Questline. Tous " +
            'les autres appareils seront alors déconnectés.',
        ],
      },
      account_deleted_notice: {
        subject: 'Votre compte Questline va être supprimé',
        paragraphs: [
          'Votre compte Questline a été désactivé et sera définitivement supprimé dans {days} jours. Si vous vous ' +
            "connectez d'ici là, il sera réactivé.",
          "Si ce n'était pas vous, connectez-vous immédiatement et modifiez votre mot de passe.",
        ],
      },
    },
  },
  it: {
    greeting: 'Buongiorno,',
    links: {
      verify_email: {
        subject: 'Confermi il Suo indirizzo e-mail',
        before: 'Confermi il Suo indirizzo e-mail per Questline aprendo questo link entro {minutes} minuti:',
        after: 'Se non ha creato un account Questline, può ignorare questa e-mail.',
      },
      password_reset: {
        subject: 'Reimposti la Sua password',
        before:
          'È stata richiesta una nuova password per il Suo account Questline. Apra questo link entro {minutes} ' +
          'minuti per sceglierla:',
        after: 'Se non ha fatto Lei la richiesta, può ignorare questa e-mail. La Sua password resta invariata.',
      },
      email_change_verify: {
        subject: 'Confermi il Suo nuovo indirizzo e-mail',
        before:
          'Confermi che questo indirizzo deve essere utilizzato per il Suo account Questline aprendo questo link ' +
          'entro {minutes} minuti:',
        after: 'Se non ha fatto Lei la richiesta, può ignorare questa e-mail.',
      },
    },
    notices: {
      registration_notice: {
        subject: 'Qualcuno ha tentato di usare il Suo indirizzo e-mail',
        paragraphs: [
          'Qualcuno ha tentato di creare un account Questline con questo indirizzo e-mail o di trasferirvi un ' +
            "account. L'indirizzo appartiene già a un account Questline, quindi non è stato modificato nulla.",
          'Se è stato Lei, acceda con il Suo account esistente. Se ha dimenticato la password, la reimposti ' +
            "nell'app Questline.",
          'Se non è stato Lei, può ignorare questa e-mail.',
        ],
      },
      password_changed_notice: {
        subject: 'La Sua password è stata modificata',
        paragraphs: [
          'La password del Suo account Questline è appena stata modificata.',
          "Se non è stato Lei, reimposti subito la password nell'app Questline. Tutti i dispositivi verranno così " +
            'disconnessi.',
        ],
      },
      email_change_notice: {
        subject: 'Il Suo indirizzo e-mail sta per essere modificato',
        paragraphs: [
          "È stata richiesta la modifica dell'indirizzo e-mail del Suo account Questline verso un altro indirizzo. " +
            'La modifica sarà effettiva non appena il nuovo indirizzo sarà confermato.',
          "Se non è stato Lei, modifichi subito la password nell'app Questline. Tutti gli altri dispositivi " +
            'verranno così disconnessi.',
        ],
      },
      account_deleted_notice: {
        subject: 'Il Suo account Questline verrà eliminato',
        paragraphs: [
          'Il Suo account Questline è stato disattivato e verrà eliminato definitivamente tra {days} giorni. Se ' +
            'accede prima di allora, verrà riattivato.',
          'Se non è stato Lei, acceda subito e modifichi la password.',
        ],
      },
    },
  },
};

const fill = (text: string): string =>
  text
    .replaceAll('{minutes}', String(ONE_TIME_TOKEN_LIFETIME_MS / 60_000))
    .replaceAll('{days}', String(DELETION_GRACE_DAYS));

export function renderEmail(content: EmailContent, locale: Locale): RenderedEmail {
  const language = COPY[LANGUAGES[locale]];
  let subject: string;
  let paragraphs: readonly string[];
  if ('link' in content) {
    const copy = language.links[content.template];
    subject = copy.subject;
    paragraphs = [fill(copy.before), content.link, copy.after];
  } else {
    const copy = language.notices[content.template];
    subject = copy.subject;
    paragraphs = copy.paragraphs.map(fill);
  }
  return { subject, text: `${[language.greeting, ...paragraphs, SIGNATURE].join('\n\n')}\n` };
}
