import { DocumentPage, documentMetadata } from '../document-page';

export const metadata = documentMetadata('consent');

export default function ConsentPage() {
  return <DocumentPage slug="consent" />;
}
