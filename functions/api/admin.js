export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Authentication
    const providedPassword = request.headers.get('X-Admin-Password');
    const correctPassword = env.ADMIN_PASSWORD;
    const token = env.DATOCMS_FULL_ACCESS_TOKEN;
    const readToken = 'd6ee5c482b25f0034b4119f94c7c18';

    if (!correctPassword || !token) {
      return new Response(JSON.stringify({ error: 'Erro de configuração: Variáveis de ambiente faltando no Cloudflare.' }), { status: 500 });
    }

    if (providedPassword !== correctPassword) {
      return new Response(JSON.stringify({ error: 'Senha Mestre incorreta.' }), { status: 401 });
    }

    const headersCMA = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/vnd.api+json',
      'X-Api-Version': '3'
    };

    // 2. Parse Request
    // We expect FormData for file uploads, but JSON for data fetching and deletions.
    // Let's handle both based on Content-Type.
    const contentType = request.headers.get('Content-Type') || '';
    let action = '';
    let data = {};
    let file = null;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      action = formData.get('action');
      file = formData.get('file');
      data = Object.fromEntries(formData.entries());
    } else {
      const json = await request.json();
      action = json.action;
      data = json;
    }

    if (!action) {
      throw new Error('Ação não especificada.');
    }

    // ----------------------------------------------------
    // ACTION: GET_DATA (Fetch all beers and gallery images)
    // ----------------------------------------------------
    if (action === 'get_data') {
      const query = `
      {
        allCervejas(orderBy: _createdAt_DESC) {
          id
          _status
          nome
          estilo
          tamanho
          preco
          desc
          categoria
          imagem { id url }
        }
        allUploads(filter: {tags: {anyIn: ["galeria"]}}, orderBy: _createdAt_DESC) {
          id
          url
          alt
        }
      }`;

      const res = await fetch('https://graphql.datocms.com/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${readToken}`,
          'X-Include-Drafts': 'true' // VERY IMPORTANT: Returns 'Esgotado' (Unpublished) beers
        },
        body: JSON.stringify({ query })
      });
      const json = await res.json();
      if (json.errors) throw new Error(json.errors[0].message);
      
      return new Response(JSON.stringify({ success: true, data: json.data }), { status: 200 });
    }

    // ----------------------------------------------------
    // ACTION: UPLOAD_GALLERY
    // ----------------------------------------------------
    if (action === 'upload_gallery') {
      if (!file) throw new Error('Arquivo de imagem ausente.');
      
      const uploadId = await uploadToDatoCMS(file, token, readToken, ['galeria'], data.alt);
      return new Response(JSON.stringify({ success: true, message: 'Adicionado à galeria!', id: uploadId }), { status: 200 });
    }

    // ----------------------------------------------------
    // ACTION: DELETE_GALLERY
    // ----------------------------------------------------
    if (action === 'delete_gallery') {
      const res = await fetch(`https://site-api.datocms.com/uploads/${data.id}`, {
        method: 'DELETE',
        headers: headersCMA
      });
      if (!res.ok) throw new Error('Falha ao excluir a imagem do DatoCMS.');
      return new Response(JSON.stringify({ success: true, message: 'Imagem excluída.' }), { status: 200 });
    }

    // ----------------------------------------------------
    // ACTION: CREATE_BEER
    // ----------------------------------------------------
    if (action === 'create_beer') {
      if (!file) throw new Error('O rótulo (imagem) é obrigatório.');

      // 1. Upload image to DatoCMS Media Area
      const imageId = await uploadToDatoCMS(file, token, readToken, ['rotulo'], `Rótulo ${data.nome}`);

      // 2. Get the 'cerveja' Model ID
      const modelsRes = await fetch('https://site-api.datocms.com/item-types', { headers: headersCMA });
      const modelsData = await modelsRes.json();
      const beerModel = modelsData.data.find(m => m.attributes.api_key === 'cerveja');
      if (!beerModel) throw new Error('Modelo "cerveja" não encontrado no DatoCMS.');

      // 3. Price format (DatoCMS schema expects a string for price)
      let parsedPrice = data.preco.toString();

      // 4. Create the Item
      const createItemRes = await fetch('https://site-api.datocms.com/items', {
        method: 'POST',
        headers: headersCMA,
        body: JSON.stringify({
          data: {
            type: 'item',
            attributes: {
              nome: data.nome,
              estilo: data.estilo,
              preco: parsedPrice,
              tamanho: data.tamanho,
              categoria: data.categoria,
              desc: data.desc,
              imagem: {
                upload_id: imageId
              }
            },
            relationships: {
              item_type: { data: { id: beerModel.id, type: 'item_type' } }
            }
          }
        })
      });

      if (!createItemRes.ok) {
        const errTxt = await createItemRes.text();
        throw new Error(`Falha ao criar cerveja: ${errTxt}`);
      }

      return new Response(JSON.stringify({ success: true, message: 'Cerveja cadastrada com sucesso!' }), { status: 200 });
    }

    // ----------------------------------------------------
    // ACTION: TOGGLE_BEER (Publish / Unpublish)
    // ----------------------------------------------------
    if (action === 'toggle_beer') {
      const endpoint = (data.publish === 'true' || data.publish === true) ? 'publish' : 'unpublish';
      const res = await fetch(`https://site-api.datocms.com/items/${data.id}/${endpoint}`, {
        method: 'PUT',
        headers: headersCMA
      });
      if (!res.ok) throw new Error('Falha ao alterar o status do estoque.');
      return new Response(JSON.stringify({ success: true, message: 'Estoque atualizado!' }), { status: 200 });
    }

    // ----------------------------------------------------
    // ACTION: DELETE_BEER
    // ----------------------------------------------------
    if (action === 'delete_beer') {
      const res = await fetch(`https://site-api.datocms.com/items/${data.id}`, {
        method: 'DELETE',
        headers: headersCMA
      });
      if (!res.ok) throw new Error('Falha ao excluir a cerveja.');
      
      // Delete the attached image to keep Media Area clean
      if (data.imageId && data.imageId !== 'undefined') {
        await fetch(`https://site-api.datocms.com/uploads/${data.imageId}`, {
          method: 'DELETE',
          headers: headersCMA
        });
      }
      
      return new Response(JSON.stringify({ success: true, message: 'Cerveja excluída permanentemente.' }), { status: 200 });
    }

    throw new Error('Ação inválida.');

  } catch (error) {
    console.error('Admin API Error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Erro interno no servidor.' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ------------------------------------------------------------------
// HELPER: Upload File to DatoCMS (3-step process)
// ------------------------------------------------------------------
async function uploadToDatoCMS(file, token, readToken, tags, altText) {
  const headersCMA = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/vnd.api+json',
    'X-Api-Version': '3'
  };

  // Prevent URL encoding NOT_FOUND bugs in S3 by forcing safe alphanumeric filenames
  const ext = file.name ? file.name.substring(file.name.lastIndexOf('.')) : '.png';
  const safeName = 'img_' + Date.now() + ext.replace(/[^a-zA-Z0-9.]/g, '');

  // Step 1: Request S3 Upload URL
  const uploadRequestRes = await fetch('https://site-api.datocms.com/upload-requests', {
    method: 'POST',
    headers: headersCMA,
    body: JSON.stringify({
      data: { type: 'upload_request', attributes: { filename: safeName } }
    })
  });
  if (!uploadRequestRes.ok) throw new Error('Falha ao solicitar URL de upload.');
  const uploadRequestData = await uploadRequestRes.json();
  const s3Path = uploadRequestData.data.id;
  const uploadUrl = uploadRequestData.data.attributes.url;

  // Step 2: Upload to S3
  const s3UploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: await file.arrayBuffer()
  });
  if (!s3UploadRes.ok) throw new Error('Falha no upload para AWS S3.');

  // Determine Primary Locale to safely set Alt Text
  const siteRes = await fetch('https://site-api.datocms.com/site', { headers: headersCMA });
  const siteData = await siteRes.json();
  const primaryLocale = siteData.data.attributes.locales[0] || 'pt';

  // Step 3: Create Upload Record in DatoCMS
  const createUploadRes = await fetch('https://site-api.datocms.com/uploads', {
    method: 'POST',
    headers: headersCMA,
    body: JSON.stringify({
      data: {
        type: 'upload',
        attributes: {
          path: s3Path,
          tags: tags,
          default_field_metadata: {
            [primaryLocale]: { alt: altText || '', title: null, custom_data: {} }
          }
        }
      }
    })
  });
  if (!createUploadRes.ok) throw new Error('Falha ao finalizar o upload no DatoCMS.');
  const uploadFinalData = await createUploadRes.json();
  
  if (uploadFinalData.data && uploadFinalData.data.type === 'upload') {
    return uploadFinalData.data.id;
  }
  
  // O DatoCMS retornou um Job. Em vez de usar o /job-results (que está dando 404 falso),
  // vamos consultar a API GraphQL com segurança até que a imagem apareça na biblioteca!
  let finalId = null;
  let attempts = 0;
  
  while (!finalId && attempts < 15) {
    await new Promise(r => setTimeout(r, 1500));
    const query = `{ allUploads(filter: { filename: { matches: { pattern: "${safeName}" } } }, orderBy: _createdAt_DESC, first: 1) { id } }`;
    const gqlRes = await fetch('https://graphql.datocms.com/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${readToken}`,
        'Content-Type': 'application/json',
        'X-Include-Drafts': 'true' // Ignora o cache
      },
      body: JSON.stringify({ query })
    });
    
    const gqlJson = await gqlRes.json();
    if (gqlJson.data && gqlJson.data.allUploads && gqlJson.data.allUploads.length > 0) {
      finalId = gqlJson.data.allUploads[0].id;
    }
    attempts++;
  }

  if (!finalId) {
    throw new Error('A imagem foi enviada, mas demorou muito para processar no banco. Tente novamente.');
  }

  return finalId;
}
