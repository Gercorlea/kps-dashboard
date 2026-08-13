# Prompts de generación de medios

Este proyecto es **dashboard-only y no usa imágenes ni video generados con
IA**. No hay prompts de imagen/video que documentar y no deben inventarse.

Los 5 assets de marca (`public/Arcanum*.png`) son archivos existentes de la
marca **Arcanum**: **no se generan con IA**, se dan por hechos y no se
sustituyen (ver `DESIGN.md`).

El único uso de IA en el producto es el chat de **KPS AI** (texto,
streaming), configurado en `src/lib/ai.ts` vía Vercel AI Gateway; su system
prompt vive en ese archivo y se versiona con el código.
