import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

export class PdfService {
  /**
   * Generates a PDF buffer from a simple Markdown-like text or raw text.
   * Very basic implementation for meeting notes.
   */
  async generateNotesPdf(title: string, date: string, content: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const buffers: Buffer[] = [];
        
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
          resolve(Buffer.concat(buffers));
        });

        // Header
        doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(12).font('Helvetica').text(`Date: ${date}`, { align: 'center' });
        doc.moveDown(2);

        // Body
        // Handle very basic markdown-like syntax
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.startsWith('# ')) {
            doc.fontSize(16).font('Helvetica-Bold').text(line.substring(2));
            doc.moveDown(0.5);
          } else if (line.startsWith('## ')) {
            doc.fontSize(14).font('Helvetica-Bold').text(line.substring(3));
            doc.moveDown(0.5);
          } else if (line.startsWith('- ') || line.startsWith('* ')) {
            doc.fontSize(12).font('Helvetica').text(`• ${line.substring(2)}`, { indent: 20 });
            doc.moveDown(0.2);
          } else {
            doc.fontSize(12).font('Helvetica').text(line);
            doc.moveDown(0.2);
          }
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}
